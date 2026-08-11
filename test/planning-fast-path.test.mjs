import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileArtifactCache } from "../src/cache.mjs";
import { automaticConsensusGroups, registrationVariants } from "../src/planning/georeference.mjs";
import { runPlanningFastPath } from "../src/planning/fast-path.mjs";
import { normalizePlanningVectors } from "../src/planning/vectorize.mjs";

function candidate(lon, rank = 0, confidence = 0.88) {
  return {
    points: [{ x: 0, y: 0, longitude: lon, latitude: 52.98 }],
    confidence,
    candidateLocation: { longitude: lon, latitude: 52.98 },
    quality: { f1: 0.94, precision: 0.95, recall: 0.93 },
    alternativeRank: rank
  };
}

test("consensus selects cross-document alternatives using Mapping Engine thresholds", () => {
  const result = automaticConsensusGroups([
    { id: "a", sourceSha256: "a", applicationReference: "x", automaticCandidate: { ...candidate(-1.87), alternatives: [candidate(-1.8800, 2)] } },
    { id: "b", sourceSha256: "b", applicationReference: "x", automaticCandidate: { ...candidate(-1.89), alternatives: [candidate(-1.8802, 2)] } }
  ]);
  assert.deepEqual([...result.accepted].sort(), ["a", "b"]);
  assert.equal(result.minimumConfidence, 0.72);
  assert.equal(result.maxSeparationM, 140);
  assert.equal(result.evidence[0].selectedAlternativeDocuments, 2);
});

test("registration variants suppress near-duplicates and cap at 12", () => {
  const alternatives = Array.from({ length: 20 }, (_, index) => candidate(-1.88 + index * 0.001, index + 1));
  const variants = registrationVariants({ automaticCandidate: { ...candidate(-1.88), alternatives } });
  assert.ok(variants.length <= 12);
  assert.equal(variants[0].alternativeRank, 0);
});

test("planning semantic vectors become planning-authoritative normalized features", () => {
  const result = normalizePlanningVectors([
    { role: "site-path-centerline-candidate", confidence: 0.91, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: { material: "red-tarmac" } },
    { role: "ride-layout-candidate", confidence: 0.89, geometry: { type: "LineString", coordinates: [[0, 0], [2, 2]] } }
  ], { applicationReference: "SMD/2017/0111", documentId: "doc", sourceSha256: "abc", page: 1 });
  assert.equal(result.features.length, 2);
  assert.equal(result.features[0].properties.source, "planning");
  assert.equal(result.features[0].properties.featureClass, "path");
  assert.equal(result.features[0].properties.planning_surface_authority, "planning-drawing");
  assert.equal(result.features[1].properties.featureClass, "ride-layout");
});

test("fast path reuses render, semantic, registration and vector stages on warm cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-planning-"));
  try {
    const cache = new FileArtifactCache(root);
    const calls = { render: 0, semantic: 0, registration: 0, vector: 0 };
    const processors = {
      renderPage: async ({ document, page }) => ({ sha256: `page-${document.sha256}-${page}`, width: 1000, height: 1000, calls: ++calls.render }),
      extractSemantics: async ({ document }) => ({ anchors: [{ text: document.id }], calls: ++calls.semantic }),
      registerPage: async ({ document }) => ({ status: "candidate", pageWidth: 1000, pageHeight: 1000, ...candidate(document.id === "a" ? -1.8800 : -1.8802), calls: ++calls.registration }),
      vectorizePage: async () => ({ vectors: [{ role: "site-path-centerline-candidate", confidence: 0.9, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }], calls: ++calls.vector })
    };
    const documents = [
      { id: "a", sha256: "sha-a", applicationReference: "SMD/2017/0111", pages: [1] },
      { id: "b", sha256: "sha-b", applicationReference: "SMD/2017/0111", pages: [1] }
    ];
    const fastPathOptions = { enforceAuthorityGate: false };
    const first = await runPlanningFastPath({ documents, cache, processors, referenceHash: "ref", bbox: [52.9, -1.9, 53, -1.8], options: fastPathOptions });
    assert.equal(first.features.length, 2);
    assert.deepEqual(calls, { render: 2, semantic: 2, registration: 2, vector: 2 });
    const second = await runPlanningFastPath({ documents, cache, processors, referenceHash: "ref", bbox: [52.9, -1.9, 53, -1.8], options: fastPathOptions });
    assert.equal(second.features.length, 2);
    assert.deepEqual(calls, { render: 2, semantic: 2, registration: 2, vector: 2 });
    assert.equal(second.metrics.renderHits, 2);
    assert.equal(second.metrics.semanticHits, 2);
    assert.equal(second.metrics.registrationHits, 2);
    assert.equal(second.metrics.vectorHits, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changing reference hash invalidates registration and vectorization but reuses render and semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-planning-ref-"));
  try {
    const cache = new FileArtifactCache(root);
    const calls = { render: 0, semantic: 0, registration: 0, vector: 0 };
    const processors = {
      renderPage: async ({ document }) => ({ sha256: `page-${document.sha256}`, calls: ++calls.render }),
      extractSemantics: async () => ({ anchors: [], calls: ++calls.semantic }),
      registerPage: async ({ document, referenceHash }) => ({ status: "candidate", ...candidate(document.id === "a" ? -1.8800 : -1.8802), quality: { f1: referenceHash === "ref-2" ? 0.95 : 0.94 }, calls: ++calls.registration }),
      vectorizePage: async () => ({ vectors: [{ role: "ride-layout-candidate", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }], calls: ++calls.vector })
    };
    const documents = [
      { id: "a", sha256: "sha-a", applicationReference: "x" },
      { id: "b", sha256: "sha-b", applicationReference: "x" }
    ];
    const fastPathOptions = { enforceAuthorityGate: false };
    await runPlanningFastPath({ documents, cache, processors, referenceHash: "ref-1", options: fastPathOptions });
    await runPlanningFastPath({ documents, cache, processors, referenceHash: "ref-2", options: fastPathOptions });
    assert.equal(calls.render, 2);
    assert.equal(calls.semantic, 2);
    assert.equal(calls.registration, 4);
    assert.equal(calls.vector, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
