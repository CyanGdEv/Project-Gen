import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileArtifactCache } from "../cache.mjs";
import { ingestPlanningPrefetch } from "../sources/planning-prefetch.mjs";
import { runPlanningFastPath } from "./fast-path.mjs";
import { planningStrongGeoreferenceKey } from "./cache-keys.mjs";
import { createNativePlanningProcessors, runTool, sha256File } from "./native-workers.mjs";
import { resolveStrongGeoreference } from "./strong-georeference.mjs";

function safePath(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error("planning prefetch document path must be relative");
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`planning prefetch path escapes root: ${relative}`);
  return resolved;
}

function finite(value) {
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
    const appLocation = locationPrior(application);
    for (const document of application?.downloadedDocuments || application?.documents || []) {
      if (!document || typeof document !== "object") continue;
      const metadata = {
        ...document,
        applicationReference,
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
  async function lane() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length || 1, Math.max(1, concurrency)) }, lane));
  return output;
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
      locationPrior: extra.locationPrior || null,
      explicitControlPoints: extra.explicitControlPoints || null,
      georeference: extra.georeference || null
    };
    enriched.pages = await documentPages(enriched, options);
    return enriched;
  });
}

export function createPriorityPlanningProcessors(options = {}) {
  const native = options.nativeProcessors || createNativePlanningProcessors(options);
  const cache = options.cache || null;
  return {
    ...native,
    async registerPage(args) {
      const key = planningStrongGeoreferenceKey({
        documentSha256: args.document?.sha256,
        page: args.page,
        pageSha256: args.render?.sha256,
        semanticHash: args.semantics?.sha256 || "none",
        version: options.strongGeoreferenceVersion || "strong-georef-v1"
      });
      let strongRecord = cache ? await cache.get(key) : null;
      if (!strongRecord?.resolved) {
        const strong = await resolveStrongGeoreference(args, {
          runTool: options.runTool || runTool,
          gdalinfo: options.gdalinfo,
          gdaltransform: options.gdaltransform,
          toolTimeoutMs: options.toolTimeoutMs,
          geofencePaddingM: options.geofencePaddingM,
          failOnEmbeddedInspectionError: options.failOnEmbeddedInspectionError
        });
        strongRecord = { resolved: true, value: strong };
        if (cache) await cache.put(key, strongRecord);
      }
      if (strongRecord.value) return strongRecord.value;
      return native.registerPage(args);
    }
  };
}

export async function runPlanningPrefetchFastPath(options = {}) {
  if (!options.planningDirectory) throw new Error("planningDirectory is required");
  if (!options.referenceImagePath) throw new Error("referenceImagePath is required for visual-registration fallback");
  if (!options.bbox) throw new Error("bbox is required");

  const cache = options.cache || new FileArtifactCache(options.cacheRoot || ".project-gen-cache/artifacts");
  const ingestion = await ingestPlanningPrefetch(options.planningDirectory, {
    cache,
    maxDocuments: options.maxDocuments,
    verificationConcurrency: options.verificationConcurrency
  });
  const documents = await preparePrefetchDocuments(options.planningDirectory, ingestion, options);
  const referenceHash = options.referenceHash || await sha256File(path.resolve(options.referenceImagePath));
  const processors = createPriorityPlanningProcessors({ ...options, cache, referenceImagePath: options.referenceImagePath });
  const result = await runPlanningFastPath({
    documents,
    cache,
    processors,
    referenceHash,
    bbox: options.bbox,
    options: {
      concurrency: options.concurrency || 4,
      dpi: options.dpi || 240,
      rendererVersion: options.rendererVersion || "render-v1",
      extractorVersion: options.extractorVersion || "semantic-v2-lines",
      registrationVersion: options.registrationVersion || "registration-v2-priority",
      vectorizerVersion: options.vectorizerVersion || "vector-v1",
      planningAutomaticRegistrationConsensusM: options.planningAutomaticRegistrationConsensusM,
      planningAutomaticRegistrationMinConfidence: options.planningAutomaticRegistrationMinConfidence,
      planningAutomaticRegistrationConsensusDocuments: options.planningAutomaticRegistrationConsensusDocuments
    }
  });
  return {
    source: "planning",
    status: "usable",
    ingestion: {
      cacheHit: ingestion.cacheHit,
      evidenceKey: ingestion.evidenceKey,
      stats: ingestion.stats
    },
    processedDocuments: documents.length,
    referenceHash,
    ...result
  };
}

export { documentPages, metadataIndex, locationPrior };
