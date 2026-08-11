import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileArtifactCache } from "../src/cache.mjs";
import { runPlanningFastPath } from "../src/planning/fast-path.mjs";

test("direct georeference bypasses cross-document visual consensus", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-direct-georef-"));
  try {
    const cache = new FileArtifactCache(root);
    const processors = {
      renderPage: async () => ({ sha256: "page", width: 1000, height: 1000 }),
      extractSemantics: async () => ({ sha256: "semantic", anchors: [], lines: [] }),
      registerPage: async () => ({
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
      }),
      vectorizePage: async () => ({ vectors: [{ role: "site-path-centerline-candidate", geometry: { type: "LineString", coordinates: [[-1.89, 52.99], [-1.88, 52.985]] } }] })
    };
    const result = await runPlanningFastPath({
      documents: [{ id: "single", sha256: "sha-single", applicationReference: "APP/1", pages: [1] }],
      cache,
      processors,
      referenceHash: "reference",
      bbox: [52.97, -1.90, 53.00, -1.85]
    });
    assert.deepEqual(result.georeference.directAcceptedIds, ["single"]);
    assert.deepEqual(result.georeference.consensusAcceptedIds, []);
    assert.equal(result.features.length, 1);
    assert.equal(result.metrics.directGeoreferences, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
