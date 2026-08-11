import { createHash } from "node:crypto";
import { automaticConsensusGroups, registrationVariantScore } from "./georeference.mjs";
import { planningRegistrationKey, planningRenderKey, planningSemanticKey, planningStrongGeoreferenceKey, planningVectorKey } from "./cache-keys.mjs";
import { normalizePlanningVectors } from "./vectorize.mjs";

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, run));
  return output;
}

async function cachedStage(cache, key, producer, validator = null) {
  const existing = await cache.get(key);
  if (existing !== null && (!validator || await validator(existing))) return { value: existing, cacheHit: true };
  const value = await producer();
  await cache.put(key, value);
  return { value, cacheHit: false };
}

function candidateForPage(registration, page) {
  if (!registration || !["accepted", "candidate"].includes(registration.status)) return null;
  const method = String(registration.method || (registration.status === "accepted" ? "automatic-linework-registration" : "automatic-linework-candidate"));
  return {
    method,
    directAuthority: Boolean(registration.directAuthority),
    page,
    pageWidth: Number(registration.pageWidth || 0),
    pageHeight: Number(registration.pageHeight || 0),
    crs: String(registration.crs || "EPSG:4326"),
    points: Array.isArray(registration.points) ? registration.points : [],
    confidence: Number(registration.confidence || 0),
    candidateLocation: registration.candidateLocation || null,
    quality: registration.quality || null,
    matrix: registration.matrix || null,
    cropOrigin: registration.cropOrigin || null,
    sourceImageWidth: Number(registration.sourceImageWidth || 0) || null,
    sourceImageHeight: Number(registration.sourceImageHeight || 0) || null,
    alternatives: (Array.isArray(registration.alternatives) ? registration.alternatives : []).slice(0, 12).map((candidate, index) => ({
      ...candidate,
      page,
      alternativeRank: Number(candidate?.alternativeRank ?? index + 1)
    }))
  };
}

function bestPageCandidate(pages) {
  return pages
    .filter((page) => page.candidate)
    .sort((a, b) => {
      const directDelta = Number(Boolean(b.candidate.directAuthority)) - Number(Boolean(a.candidate.directAuthority));
      if (directDelta) return directDelta;
      return registrationVariantScore(b.candidate) - registrationVariantScore(a.candidate) || a.page - b.page;
    })[0] || null;
}

async function resolvePageRegistration({ cache, processors, document, page, render, semantics, semanticHash, referenceHash, bbox, options, metrics }) {
  if (typeof processors.resolveStrongGeoreference === "function") {
    const strongKey = planningStrongGeoreferenceKey({
      documentSha256: document.sha256,
      page,
      pageSha256: render.sha256,
      semanticHash,
      bbox,
      version: options.strongGeoreferenceVersion || "strong-georef-v1"
    });
    const strong = await cachedStage(cache, strongKey, async () => ({
      resolved: true,
      value: await processors.resolveStrongGeoreference({ document, page, render, semantics, bbox })
    }));
    if (strong.cacheHit) metrics.strongGeoreferenceHits += 1;
    if (strong.value?.value) return { value: strong.value.value, cacheHit: strong.cacheHit, source: "strong" };
  }

  let visualReferenceHash = referenceHash || null;
  let visualContext = null;
  if (typeof processors.getVisualRegistrationContext === "function") {
    visualContext = await processors.getVisualRegistrationContext();
    visualReferenceHash = visualContext?.referenceHash || visualReferenceHash;
  }
  if (!visualReferenceHash) throw new Error(`visual registration reference hash missing for ${document.id || document.sha256} page ${page}`);

  const registration = await cache.getOrCreate(planningRegistrationKey({
    pageSha256: render.sha256,
    referenceHash: visualReferenceHash,
    registrationVersion: options.registrationVersion || "registration-v1",
    bbox,
    locationPrior: document.locationPrior || null
  }), () => processors.registerPage({
    document,
    page,
    render,
    semantics,
    referenceHash: visualReferenceHash,
    referenceImagePath: visualContext?.referenceImagePath || null,
    bbox
  }));
  if (registration.cacheHit) metrics.registrationHits += 1;
  return { ...registration, source: "visual" };
}

export async function runPlanningFastPath({ documents, cache, processors, referenceHash = null, bbox = null, options = {} }) {
  if (!cache) throw new Error("planning fast path requires cache");
  for (const name of ["renderPage", "extractSemantics", "registerPage", "vectorizePage"]) {
    if (typeof processors?.[name] !== "function") throw new Error(`planning fast path requires processors.${name}()`);
  }
  const concurrency = Math.max(1, Number(options.concurrency || 4));
  const metrics = {
    renderHits: 0,
    semanticHits: 0,
    strongGeoreferenceHits: 0,
    registrationHits: 0,
    vectorHits: 0,
    documents: documents.length,
    pages: 0,
    directGeoreferences: 0,
    consensusGeoreferences: 0
  };

  const prepared = await mapConcurrent(documents, concurrency, async (document) => {
    const pages = Array.isArray(document.pages) && document.pages.length ? document.pages : [1];
    const pageResults = [];
    for (const page of pages) {
      metrics.pages += 1;
      const render = await cachedStage(cache, planningRenderKey({
        documentSha256: document.sha256,
        page,
        dpi: options.dpi || 240,
        rendererVersion: options.rendererVersion || "render-v1"
      }), () => processors.renderPage({ document, page, dpi: options.dpi || 240 }), processors.validateRenderArtifact || null);
      if (render.cacheHit) metrics.renderHits += 1;
      if (!render.value?.sha256) throw new Error(`renderPage must return sha256 for ${document.id || document.sha256} page ${page}`);

      const semantics = await cache.getOrCreate(planningSemanticKey({
        pageSha256: render.value.sha256,
        extractorVersion: options.extractorVersion || "semantic-v1"
      }), () => processors.extractSemantics({ document, page, render: render.value }));
      if (semantics.cacheHit) metrics.semanticHits += 1;
      const semanticHash = semantics.value?.sha256 || hashJson(semantics.value);

      const registration = await resolvePageRegistration({
        cache,
        processors,
        document,
        page,
        render: render.value,
        semantics: semantics.value,
        semanticHash,
        referenceHash,
        bbox,
        options,
        metrics
      });
      pageResults.push({ page, render: render.value, semantics: semantics.value, semanticHash, registration: registration.value, candidate: candidateForPage(registration.value, page) });
    }
    const best = bestPageCandidate(pageResults);
    return {
      id: document.id || document.sha256,
      sourceSha256: document.sha256,
      applicationReference: document.applicationReference || "unknown",
      document,
      pages: pageResults,
      automaticCandidate: best?.candidate || null,
      selectedPage: best?.page || null
    };
  });

  const directSelected = new Map();
  const consensusInput = [];
  for (const entry of prepared) {
    const direct = entry.pages
      .filter((page) => page.candidate?.directAuthority && page.registration?.status === "accepted")
      .sort((a, b) => registrationVariantScore(b.candidate) - registrationVariantScore(a.candidate) || a.page - b.page)[0];
    if (direct) {
      directSelected.set(entry.id, direct.candidate);
      continue;
    }
    if (entry.automaticCandidate) consensusInput.push(entry);
  }

  const consensus = automaticConsensusGroups(consensusInput, options);
  const selectedCandidates = new Map([...consensus.selectedCandidates, ...directSelected]);
  const acceptedIds = new Set([...consensus.accepted, ...directSelected.keys()]);
  metrics.directGeoreferences = directSelected.size;
  metrics.consensusGeoreferences = consensus.accepted.size;

  const acceptedDocuments = prepared.filter((entry) => acceptedIds.has(entry.id));
  const vectorized = await mapConcurrent(acceptedDocuments, concurrency, async (entry) => {
    const selectedCandidate = selectedCandidates.get(entry.id);
    const selectedPage = entry.pages.find((page) => page.page === Number(selectedCandidate?.page || entry.selectedPage))
      || entry.pages.find((page) => page.candidate === selectedCandidate)
      || entry.pages.find((page) => page.page === entry.selectedPage);
    if (!selectedPage) throw new Error(`selected georeference missing page for ${entry.id}`);
    const transformHash = hashJson(selectedCandidate);
    const vector = await cache.getOrCreate(planningVectorKey({
      pageSha256: selectedPage.render.sha256,
      semanticHash: selectedPage.semanticHash,
      transformHash,
      vectorizerVersion: options.vectorizerVersion || "vector-v1"
    }), () => processors.vectorizePage({
      document: entry.document,
      page: selectedPage.page,
      render: selectedPage.render,
      semantics: selectedPage.semantics,
      candidate: selectedCandidate,
      bbox
    }));
    if (vector.cacheHit) metrics.vectorHits += 1;
    const normalized = normalizePlanningVectors(vector.value?.vectors || vector.value || [], {
      applicationReference: entry.applicationReference,
      documentId: entry.id,
      sourceSha256: entry.sourceSha256,
      page: selectedPage.page,
      confidence: selectedCandidate?.confidence
    });
    return { id: entry.id, page: selectedPage.page, candidate: selectedCandidate, ...normalized };
  });

  return {
    documents: prepared,
    georeference: {
      acceptedIds: [...acceptedIds].sort(),
      directAcceptedIds: [...directSelected.keys()].sort(),
      consensusAcceptedIds: [...consensus.accepted].sort(),
      evidence: consensus.evidence,
      minimumDocuments: consensus.minimumDocuments,
      minimumConfidence: consensus.minimumConfidence,
      maxSeparationM: consensus.maxSeparationM
    },
    consensus: {
      acceptedIds: [...consensus.accepted].sort(),
      evidence: consensus.evidence,
      minimumDocuments: consensus.minimumDocuments,
      minimumConfidence: consensus.minimumConfidence,
      maxSeparationM: consensus.maxSeparationM
    },
    features: vectorized.flatMap((entry) => entry.features),
    vectorized,
    metrics
  };
}
