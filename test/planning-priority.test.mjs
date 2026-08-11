import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileArtifactCache } from "../src/cache.mjs";
import { runPlanningFastPath } from "../src/planning/fast-path.mjs";

function directCandidate() {
  return {
    status: "accepted",
    method: "explicit-control-points",
    directAuthority: true,
    pageWidth: 1000,
    pageHeight: 1000,
    confidence: 1,
    candidateLocation: { longitude: -1.88, latitude: 52.99 },
    points: [
      { x: 0, y: 0, longitude: -1.89, latitude: 52.995 },
      { x: 1000, y: 0, longitude: -1.87, latitude: 52.995 },
      { x: 0, y: 1000, longitude: -1.89, latitude: 52.98 }
    ]
  };
}

test("direct approved georeference bypasses cross-document visual consensus and becomes authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-direct-georef-"));
  try {
    const cache = new FileArtifactCache(root);
    let visualReferenceCalls = 0;
    const processors = {
      renderPage: async () => ({ sha256: "page", width: 1000, height: 1000 }),
      extractSemantics: async () => ({ sha256: "semantic", anchors: [], lines: [] }),
      resolveStrongGeoreference: async () => directCandidate(),
      getVisualRegistrationContext: async () => {
        visualReferenceCalls += 1;
        throw new Error("visual reference should not be built for direct controls");
      },
      registerPage: async () => { throw new Error("OpenCV should not run for direct controls"); },
      vectorizePage: async () => ({ vectors: [{ role: "site-path-centerline-candidate", geometry: { type: "LineString", coordinates: [[-1.89, 52.99], [-1.88, 52.985]] } }] })
    };
    const result = await runPlanningFastPath({
      documents: [{ id: "single", sha256: "sha-single", applicationReference: "APP/1", applicationStatus: "approved", pages: [1] }],
      cache,
      processors,
      bbox: [52.97, -1.90, 53.00, -1.85]
    });
    assert.deepEqual(result.georeference.directCandidateIds, ["single"]);
    assert.deepEqual(result.georeference.directAcceptedIds, ["single"]);
    assert.deepEqual(result.georeference.consensusAcceptedIds, []);
    assert.equal(result.features.length, 1);
    assert.equal(result.metrics.directGeoreferences, 1);
    assert.equal(result.metrics.authorityAccepted, 1);
    assert.equal(visualReferenceCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("null strong georeference falls through to visual registration once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-visual-fallback-"));
  try {
    const cache = new FileArtifactCache(root);
    let visualReferenceCalls = 0;
    let visualRegistrationCalls = 0;
    const visualCandidate = {
      status: "candidate",
      pageWidth: 1000,
      pageHeight: 1000,
      confidence: 0.9,
      candidateLocation: { longitude: -1.88, latitude: 52.99 },
      points: [{ x: 0, y: 0, longitude: -1.88, latitude: 52.99 }],
      quality: { f1: 0.9, precision: 0.9, recall: 0.9 }
    };
    const processors = {
      renderPage: async ({ document }) => ({ sha256: `page-${document.id}`, width: 1000, height: 1000 }),
      extractSemantics: async () => ({ sha256: "semantic", anchors: [], lines: [] }),
      resolveStrongGeoreference: async () => null,
      getVisualRegistrationContext: async () => {
        visualReferenceCalls += 1;
        return { referenceHash: "osm-ref", referenceImagePath: "/tmp/osm-ref.png" };
      },
      registerPage: async () => { visualRegistrationCalls += 1; return visualCandidate; },
      vectorizePage: async () => ({ vectors: [] })
    };
    await runPlanningFastPath({
      documents: [{ id: "a", sha256: "a", applicationReference: "APP/1", applicationStatus: "approved" }],
      cache,
      processors,
      bbox: [52.97, -1.90, 53.00, -1.85]
    });
    assert.equal(visualReferenceCalls, 1);
    assert.equal(visualRegistrationCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
