import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { contentKey } from "../cache.mjs";

export const PLANNING_PREFETCH_INGEST_VERSION = 2;

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff"
]);

const GEOMETRY_TERMS = [
  ["ride-layout", 150, /\b(?:ride|roller\s*coaster|coaster|track)\s+(?:layout|plan|ga|general arrangement)\b/i],
  ["site-plan", 130, /\b(?:proposed\s+)?site\s+plan\b/i],
  ["block-plan", 125, /\bblock\s+plan\b/i],
  ["general-arrangement", 120, /\b(?:general\s+arrangement|g\.?a\.?\s+(?:plan|layout|drawing))\b/i],
  ["layout", 115, /\b(?:site|master|overall|proposed)\s+layout\b/i],
  ["topographical-survey", 112, /\b(?:topographical|topographic|topo)\s+(?:survey|plan|drawing)\b/i],
  ["landscape", 110, /\b(?:landscape|landscaping|planting|hardscape|hard\s+landscaping)\b/i],
  ["elevation", 100, /\b(?:elevation|section|roof\s+plan)\b/i],
  ["drainage-water", 90, /\b(?:drainage|water|pond|lake|attenuation)\b/i]
];

const NARRATIVE_TERMS = /\b(?:statement|report|letter|application\s+form|cover(?:ing)?\s+letter|certificate|notice|checklist|consultation|decision|condition|assessment|survey\s+report)\b/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelativePath(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error("planning artifact path must be relative");
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`planning artifact path escapes prefetch directory: ${relative}`);
  }
  return { resolved, relative: rel.split(path.sep).join("/") };
}

function strictCount(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`invalid ${name}`);
  return number;
}

function searchableText(entry, applicationMetadata) {
  return [
    entry.title,
    entry.name,
    entry.text,
    entry.description,
    entry.documentType,
    entry.document_type,
    entry.role,
    entry.documentRole,
    entry.document_role,
    entry.drawingTitle,
    entry.drawing_title,
    entry.label,
    applicationMetadata?.title,
    applicationMetadata?.name,
    applicationMetadata?.text,
    applicationMetadata?.description,
    applicationMetadata?.documentType,
    applicationMetadata?.document_type,
    applicationMetadata?.role,
    applicationMetadata?.documentRole,
    applicationMetadata?.document_role,
    applicationMetadata?.drawingTitle,
    applicationMetadata?.drawing_title,
    applicationMetadata?.label
  ].filter(Boolean).join(" ").trim();
}

export function classifyPlanningDocument(metadata = {}) {
  const text = searchableText(metadata, metadata.applicationMetadata);
  for (const [classification, score, pattern] of GEOMETRY_TERMS) {
    if (pattern.test(text)) return { classification, priority: score, narrative: false };
  }
  if (NARRATIVE_TERMS.test(text)) return { classification: "narrative", priority: -100, narrative: true };
  return { classification: "unknown", priority: 0, narrative: false };
}

function documentMetadataByIdentity(manifest) {
  const byUrl = new Map();
  const byFile = new Map();
  for (const application of manifest.applications || []) {
    const reference = application?.reference || application?.applicationReference || application?.application_reference || null;
    for (const document of application?.downloadedDocuments || application?.documents || []) {
      if (!document || typeof document !== "object") continue;
      const enriched = { ...document, applicationReference: reference };
      const url = document.url || document.href || document.documentUrl || document.document_url;
      const file = document.file || document.path;
      if (url && !byUrl.has(String(url))) byUrl.set(String(url), enriched);
      if (file && !byFile.has(String(file))) byFile.set(String(file), enriched);
    }
  }
  return { byUrl, byFile };
}

function evidenceDescriptor(manifest) {
  const documents = manifest.entries
    .filter((entry) => entry?.kind === "document")
    .map((entry) => ({
      url: String(entry.url || ""),
      file: String(entry.file || ""),
      bytes: Number(entry.bytes),
      sha256: String(entry.sha256 || "").toLowerCase(),
      mime: String(entry.mime || "").toLowerCase()
    }))
    .sort((a, b) => a.url.localeCompare(b.url) || a.file.localeCompare(b.file) || a.sha256.localeCompare(b.sha256));
  return {
    schemaVersion: manifest.schemaVersion,
    status: manifest.status,
    documents
  };
}

export function planningEvidenceKey(manifest) {
  return contentKey("planning-prefetch", {
    ingestVersion: PLANNING_PREFETCH_INGEST_VERSION,
    evidence: evidenceDescriptor(manifest)
  });
}

function cacheFingerprint(documents) {
  return documents.map((document) => ({
    file: document.file,
    bytes: document.bytes,
    mtimeMs: document.mtimeMs
  }));
}

async function fingerprintsStillValid(directory, fingerprints = []) {
  if (!fingerprints.length) return false;
  for (const fingerprint of fingerprints) {
    const { resolved } = safeRelativePath(directory, fingerprint.file);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      return false;
    }
    if (!info.isFile() || info.size !== fingerprint.bytes || info.mtimeMs !== fingerprint.mtimeMs) return false;
  }
  return true;
}

function assertManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("planning manifest must be an object");
  if (manifest.schemaVersion !== 1) throw new Error(`unsupported planning manifest schema ${manifest.schemaVersion}`);
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.applications)) {
    throw new Error("invalid planning manifest schema");
  }
  if (manifest.status === "disabled") return;
  if (manifest.status !== "usable") throw new Error(`planning manifest is not usable: ${manifest.status || "missing-status"}`);
  strictCount(manifest.liveApplications, "liveApplications");
  strictCount(manifest.documentsDownloaded, "documentsDownloaded");
}

function assertDocumentEntry(entry) {
  if (!entry || typeof entry !== "object") throw new Error("planning manifest contains an empty entry");
  if (!entry.url) throw new Error("planning document entry is missing url");
  const url = new URL(entry.url);
  if (url.protocol !== "https:") throw new Error(`planning document URL must use HTTPS: ${entry.url}`);
  if (!DOCUMENT_MIMES.has(String(entry.mime || "").toLowerCase())) {
    throw new Error(`unsupported planning document MIME ${entry.mime || "missing"}`);
  }
  if (!Number.isInteger(entry.bytes) || entry.bytes < 0) throw new Error(`invalid planning document byte count ${entry.url}`);
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) throw new Error(`invalid planning document hash ${entry.url}`);
}

async function validateDocument(directory, entry, metadata) {
  assertDocumentEntry(entry);
  const { resolved, relative } = safeRelativePath(directory, entry.file);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`planning artifact is not a file: ${relative}`);
  if (info.size !== entry.bytes) throw new Error(`planning artifact byte mismatch ${entry.url}`);
  const data = await readFile(resolved);
  const actualHash = sha256(data);
  if (actualHash !== String(entry.sha256).toLowerCase()) throw new Error(`planning artifact hash mismatch ${entry.url}`);

  const classification = classifyPlanningDocument({ ...entry, applicationMetadata: metadata });
  return {
    id: `planning:${actualHash}`,
    source: "planning",
    url: entry.url,
    file: relative,
    bytes: entry.bytes,
    sha256: actualHash,
    mime: String(entry.mime).toLowerCase(),
    applicationReference: metadata?.applicationReference || entry.applicationReference || null,
    title: entry.title || entry.name || entry.text || metadata?.title || metadata?.name || metadata?.text || null,
    documentType: entry.documentType || entry.document_type || metadata?.documentType || metadata?.document_type || null,
    role: entry.role || entry.documentRole || entry.document_role || metadata?.role || metadata?.documentRole || metadata?.document_role || null,
    classification: classification.classification,
    priority: classification.priority,
    narrative: classification.narrative,
    mtimeMs: info.mtimeMs
  };
}

function sortGeometryFirst(a, b) {
  return b.priority - a.priority
    || Number(a.narrative) - Number(b.narrative)
    || String(a.applicationReference || "").localeCompare(String(b.applicationReference || ""))
    || a.url.localeCompare(b.url);
}

async function mapConcurrent(values, concurrency, worker) {
  const output = new Array(values.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  });
  await Promise.all(lanes);
  return output;
}

export async function ingestPlanningPrefetch(directory, options = {}) {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertManifestShape(manifest);

  if (manifest.status === "disabled") {
    return {
      source: "planning",
      status: "disabled",
      cacheHit: false,
      evidenceKey: planningEvidenceKey(manifest),
      applications: [],
      documents: [],
      stats: { applications: 0, documents: 0, bytes: 0 }
    };
  }

  const actualLiveApplications = manifest.applications.filter((application) => application && typeof application === "object" && !application.failure).length;
  const declaredLiveApplications = strictCount(manifest.liveApplications, "liveApplications");
  if (declaredLiveApplications !== actualLiveApplications) {
    throw new Error(`planning live application count mismatch (${declaredLiveApplications} != ${actualLiveApplications})`);
  }

  const documentEntries = manifest.entries.filter((entry) => entry?.kind === "document");
  const expectedDocuments = strictCount(manifest.documentsDownloaded, "documentsDownloaded");
  const uniqueUrls = new Set(documentEntries.map((entry) => String(entry.url || "")));
  if (uniqueUrls.size !== expectedDocuments) {
    throw new Error(`planning downloaded document count mismatch (${expectedDocuments} != ${uniqueUrls.size})`);
  }
  const maxDocuments = Math.max(1, Number(options.maxDocuments || 1200));
  if (documentEntries.length > maxDocuments) throw new Error(`planning document ceiling exceeded (${documentEntries.length} > ${maxDocuments})`);

  const evidenceKey = planningEvidenceKey(manifest);
  const cache = options.cache || null;
  if (cache) {
    const cached = await cache.get(evidenceKey);
    if (cached?.ingestVersion === PLANNING_PREFETCH_INGEST_VERSION
      && await fingerprintsStillValid(root, cached.fingerprints)) {
      return { ...cached.result, cacheHit: true };
    }
  }

  const metadata = documentMetadataByIdentity(manifest);
  const uniqueEntries = [];
  const seenUrls = new Map();
  for (const entry of documentEntries) {
    const previous = seenUrls.get(entry.url);
    if (previous && (previous.sha256 !== entry.sha256 || previous.bytes !== entry.bytes)) {
      throw new Error(`conflicting duplicate planning document URL ${entry.url}`);
    }
    if (previous) continue;
    seenUrls.set(entry.url, entry);
    uniqueEntries.push(entry);
  }
  const verificationConcurrency = Math.min(16, Math.max(1, Number(options.verificationConcurrency || 8)));
  const documents = await mapConcurrent(uniqueEntries, verificationConcurrency, async (entry) => {
    const applicationMetadata = metadata.byUrl.get(String(entry.url)) || metadata.byFile.get(String(entry.file)) || null;
    return validateDocument(root, entry, applicationMetadata);
  });
  documents.sort(sortGeometryFirst);

  const applicationReferences = new Set(
    (manifest.applications || [])
      .filter((application) => application && typeof application === "object" && !application.failure)
      .map((application) => application.reference || application.applicationReference || application.application_reference)
      .filter(Boolean)
      .map(String)
  );
  const liveApplications = declaredLiveApplications;
  if (applicationReferences.size && applicationReferences.size > liveApplications) {
    throw new Error(`planning live application count is smaller than represented references (${liveApplications} < ${applicationReferences.size})`);
  }

  const result = {
    source: "planning",
    status: "usable",
    cacheHit: false,
    evidenceKey,
    generatedAt: manifest.generatedAt || null,
    runner: manifest.runner || null,
    tlsVerification: manifest.tlsVerification || null,
    applications: [...applicationReferences].sort(),
    documents,
    stats: {
      applications: liveApplications,
      documents: documents.length,
      bytes: documents.reduce((total, document) => total + document.bytes, 0),
      geometryFirst: documents.filter((document) => document.priority > 0).length,
      narrative: documents.filter((document) => document.narrative).length,
      verificationConcurrency
    }
  };

  if (cache) {
    await cache.put(evidenceKey, {
      ingestVersion: PLANNING_PREFETCH_INGEST_VERSION,
      fingerprints: cacheFingerprint(documents),
      result
    });
  }
  return result;
}

export function createPlanningPrefetchAdapter(options = {}) {
  if (!options.directory) throw new Error("planning prefetch adapter requires directory");
  return Object.freeze({
    id: "planning",
    async acquire(context = {}) {
      return ingestPlanningPrefetch(options.directory, {
        cache: context.cache || options.cache,
        maxDocuments: options.maxDocuments,
        verificationConcurrency: options.verificationConcurrency
      });
    }
  });
}
