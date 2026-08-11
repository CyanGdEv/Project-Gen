import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileArtifactCache } from "../cache.mjs";
import { ingestPlanningPrefetch } from "../sources/planning-prefetch.mjs";
import { summarizePlanningEvidenceDiagnostics } from "./diagnostics.mjs";
import { runPlanningFastPath } from "./fast-path.mjs";
import { createNativePlanningProcessors, runTool, sha256File } from "./native-workers.mjs";
import { normalizeOsmReferenceFeatures } from "./osm-feature-authority.mjs";
import { createPlanningProcessorProfiler, createTimingAccumulator } from "./profiler.mjs";
import { buildPlanningReference } from "./reference-raster.mjs";
import { resolveStrongGeoreference } from "./strong-georeference.mjs";

function safePath(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error("planning prefetch document path must be relative");
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`planning prefetch path escapes root: ${relative}`);
  return resolved;
}

function finite(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function locationPrior(value) {
  if (!value || typeof value !== "object") return null;
  const nested = value.location || value.coordinates || value.locationPrior || null;
  const longitude = finite(value.longitude ?? value.lon ?? value.lng ?? nested?.longitude ?? nested?.lon ?? nested?.lng ?? (Array.isArray(nested) ? nested[0] : null));
  const latitude = finite(value.latitude ?? value.lat ?? nested?.latitude ?? nested?.lat ?? (Array.isArray(nested) ? nested[1] : null));
  if (longitude === null || latitude === null || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  return { longitude, latitude };
}

function metadataIndex(manifest) {
  const byUrl = new Map();
  const byFile = new Map();
  for (const application of manifest.applications || []) {
    const applicationReference = application?.reference || application?.applicationReference || application?.application_reference || null;
    const applicationStatus = application?.status || application?.applicationStatus || application?.application_status || "unknown";
    const appLocation = locationPrior(application);
    for (const document of application?.downloadedDocuments || application?.documents || []) {
      if (!document || typeof document !== "object") continue;
      const metadata = {
        ...document,
        applicationReference,
        applicationStatus,
        locationPrior: locationPrior(document) || appLocation,
        explicitControlPoints: document.explicitControlPoints || document.controlPoints || document.georeference?.points || null,
        georeference: document.georeference || null
      };
      const url = document.url || document.href || document.documentUrl || document.document_url;
      const file = document.file || document.path;
      if (url && !byUrl.has(String(url))) byUrl.set(String(url), metadata);
      if (file && !byFile.has(String(file))) byFile.set(String(file), metadata);
    }
  }
  return { byUrl, byFile };
}

async function documentPages(document, options = {}) {
  const maxPages = Math.max(1, Math.min(24, Number(options.maxPages || 12)));
  if (String(document.mime || "").toLowerCase() !== "application/pdf" && !String(document.path || "").toLowerCase().endsWith(".pdf")) return [1];
  const { stdout } = await runTool(options.pdfinfo || "pdfinfo", [document.path], {
    timeoutMs: Number(options.toolTimeoutMs || 10000),
    maxStdoutBytes: 1024 * 1024
  });
  const match = stdout.match(/^Pages:\s+(\d+)\s*$/mi);
  const count = match ? Number(match[1]) : 1;
  return Array.from({ length: Math.min(maxPages, Math.max(1, count)) }, (_, index) => index + 1);
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  let stopped = false;
  async function lane() {
    while (!stopped) {
      const index = next++;
      if (index >= items.length) return;
      try {
        output[index] = await worker(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length || 1, Math.max(1, concurrency)) }, lane));
  return output;
}

function recoverableReferenceError(message) {
  const error = new Error(message);
  error.code = "PLANNING_REFERENCE_UNAVAILABLE";
  error.recoverablePlanningPage = true;
  return error;
}

export async function preparePrefetchDocuments(planningDirectory, ingestion, options = {}) {
  const root = path.resolve(planningDirectory);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const metadata = metadataIndex(manifest);
  const maxProcessingDocuments = Math.max(1, Number(options.maxProcessingDocuments || 500));
  const selected = ingestion.documents
    .filter((document) => !document.narrative)
    .slice(0, maxProcessingDocuments);
  const pageConcurrency = Math.min(16, Math.max(1, Number(options.pageInspectionConcurrency || 8)));

  return await mapConcurrent(selected, pageConcurrency, async (document) => {
    const extra = metadata.byUrl.get(String(document.url)) || metadata.byFile.get(String(document.file)) || {};
    const enriched = {
      ...document,
      ...extra,
      id: document.id,
      sha256: document.sha256,
      mime: document.mime,
      file: document.file,
      path: safePath(root, document.file),
      applicationReference: extra.applicationReference || document.applicationReference || "unknown",
      applicationStatus: extra.applicationStatus || document.applicationStatus || "unknown",
      locationPrior: extra.locationPrior || null,
      explicitControlPoints: extra.explicitControlPoints || null,
      georeference: extra.georeference || null
    };
    enriched.pages = await documentPages(enriched, options);
    return enriched;
  });
}

export function createPriorityPlanningProcessors(options = {}) {
  const baseNative = options.nativeProcessors || createNativePlanningProcessors({ ...options, referenceImagePath: null });
  let visualNative = null;
  let visualContext = null;

  async function getVisualRegistrationContext() {
    if (visualContext) return visualContext;
    if (typeof options.ensureVisualReference !== "function") {
      if (!options.referenceImagePath) throw recoverableReferenceError("visual planning registration requires a reference source");
      const referenceImagePath = path.resolve(options.referenceImagePath);
      visualContext = {
        referenceImagePath,
        referenceHash: options.referenceHash || await sha256File(referenceImagePath)
      };
      return visualContext;
    }
    visualContext = await options.ensureVisualReference();
    if (!visualContext?.referenceImagePath || !visualContext?.referenceHash) {
      throw recoverableReferenceError("visual reference resolver returned an incomplete context");
    }
    return visualContext;
  }

  async function getVisualNative() {
    if (visualNative) return visualNative;
    const context = await getVisualRegistrationContext();
    visualNative = createNativePlanningProcessors({ ...options, referenceImagePath: context.referenceImagePath });
    return visualNative;
  }

  return {
    ...baseNative,
    async resolveStrongGeoreference(args) {
      return resolveStrongGeoreference(args, {
        runTool: options.runTool || runTool,
        gdalinfo: options.gdalinfo,
        gdaltransform: options.gdaltransform,
        toolTimeoutMs: options.toolTimeoutMs,
        geofencePaddingM: options.geofencePaddingM,
        failOnEmbeddedInspectionError: options.failOnEmbeddedInspectionError
      });
    },
    getVisualRegistrationContext,
    async registerPage(args) {
      const native = await getVisualNative();
      return native.registerPage(args);
    },
    async vectorizePage(args) {
      if (args.candidate?.matrix) {
        const native = await getVisualNative();
        return native.vectorizePage(args);
      }
      return baseNative.vectorizePage(args);
    }
  };
}

export async function runPlanningPrefetchFastPath(options = {}) {
  if (!options.planningDirectory) throw new Error("planningDirectory is required");
  if (!options.bbox) throw new Error("bbox is required");

  const timing = createTimingAccumulator();
  const cache = options.cache || new FileArtifactCache(options.cacheRoot || ".project-gen-cache/artifacts");
  const ingestion = await timing.measure("ingestPrefetch", () => ingestPlanningPrefetch(options.planningDirectory, {
    cache,
    maxDocuments: options.maxDocuments,
    verificationConcurrency: options.verificationConcurrency
  }));
  const documents = await timing.measure("prepareDocuments", () => preparePrefetchDocuments(options.planningDirectory, ingestion, options));
  const referenceFeatures = Array.isArray(options.referenceFeatures)
    ? options.referenceFeatures
    : options.osmSource?.payload
      ? normalizeOsmReferenceFeatures(options.osmSource.payload, options.bbox)
      : [];

  let resolvedReference = null;
  let referencePromise = null;
  async function ensureVisualReference() {
    if (resolvedReference) return resolvedReference;
    if (referencePromise) return referencePromise;
    referencePromise = timing.measure("buildVisualReference", async () => {
      if (options.referenceImagePath) {
        const referenceImagePath = path.resolve(options.referenceImagePath);
        const referenceHash = options.referenceHash || await sha256File(referenceImagePath);
        resolvedReference = {
          referenceImagePath,
          referenceHash,
          reference: { path: referenceImagePath, sha256: referenceHash, role: "registration-context-only" }
        };
        return resolvedReference;
      }
      const source = options.referenceSource || options.osmSource || null;
      if (!source?.payload) throw recoverableReferenceError("visual registration fallback unavailable because the reference source could not be acquired");
      const reference = await buildPlanningReference({
        source,
        bbox: options.bbox,
        cache,
        options: options.referenceOptions || {}
      });
      resolvedReference = {
        referenceImagePath: reference.path,
        referenceHash: reference.sha256,
        reference
      };
      return resolvedReference;
    });
    return referencePromise;
  }

  const priorityProcessors = createPriorityPlanningProcessors({ ...options, cache, ensureVisualReference });
  const profiler = createPlanningProcessorProfiler(priorityProcessors);
  const result = await timing.measure("planningFastPath", () => runPlanningFastPath({
    documents,
    cache,
    processors: profiler.processors,
    referenceHash: options.referenceHash || null,
    referenceFeatures,
    bbox: options.bbox,
    options: {
      concurrency: options.concurrency || 4,
      dpi: options.dpi || 240,
      rendererVersion: options.rendererVersion || "render-v2-adaptive-gray",
      extractorVersion: options.extractorVersion || "semantic-v4-poppler-bounded-ocr",
      strongGeoreferenceVersion: options.strongGeoreferenceVersion || "strong-georef-v1",
      registrationVersion: options.registrationVersion || "registration-v2-priority",
      vectorizerVersion: options.vectorizerVersion || "vector-v1",
      planningAutomaticRegistrationConsensusM: options.planningAutomaticRegistrationConsensusM,
      planningAutomaticRegistrationMinConfidence: options.planningAutomaticRegistrationMinConfidence,
      planningAutomaticRegistrationConsensusDocuments: options.planningAutomaticRegistrationConsensusDocuments,
      planningAuthorityMinConfidence: options.planningAuthorityMinConfidence,
      planningAuthorityMinOverlap: options.planningAuthorityMinOverlap,
      planningAuthorityMaxOffsetM: options.planningAuthorityMaxOffsetM,
      planningAuthorityToleranceM: options.planningAuthorityToleranceM,
      planningAuthorityAllowGapFill: options.planningAuthorityAllowGapFill,
      failOnRecoverablePageError: options.failOnRecoverablePageError
    }
  }));
  return {
    source: "planning",
    status: "usable",
    ingestion: {
      cacheHit: ingestion.cacheHit,
      evidenceKey: ingestion.evidenceKey,
      stats: ingestion.stats
    },
    processedDocuments: documents.length,
    reference: resolvedReference?.reference || {
      role: "registration-context-only",
      status: options.osmSource?.status === "unavailable" ? "unavailable" : "not-needed"
    },
    referenceHash: resolvedReference?.referenceHash || null,
    referenceFeatureCount: referenceFeatures.length,
    ...result,
    metrics: {
      ...result.metrics,
      referenceFeatureCount: referenceFeatures.length,
      evidenceDiagnostics: summarizePlanningEvidenceDiagnostics(result.documents),
      processorTimings: profiler.snapshot(),
      orchestrationTimings: timing.snapshot()
    }
  };
}

export { documentPages, metadataIndex, locationPrior, recoverableReferenceError };
