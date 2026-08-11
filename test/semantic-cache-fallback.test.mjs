import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileArtifactCache } from "../src/cache.mjs";
import { runPlanningFastPath } from "../src/planning/fast-path.mjs";
import { extractSemanticAnchorsFromTsv } from "../src/planning/semantics.mjs";

test("bounded OCR TSV coordinates rescale back into the main planning raster", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t100\t50\t80\t20\t95\tRaised",
    "5\t1\t1\t1\t1\t2\t190\t50\t100\t20\t94\tFootbridge"
  ].join("\n");
  const result = extractSemanticAnchorsFromTsv(tsv, { coordinateScaleX: 2, coordinateScaleY: 2 });
  assert.equal(result.anchors.length, 1);
  assert.equal(result.anchors[0].role, "site-path-centerline-candidate");
  assert.equal(result.anchors[0].bounds.left, 200);
  assert.equal(result.anchors[0].bounds.top, 100);
  assert.equal(result.anchors[0].bounds.width, 380);
  assert.ok(result.anchors[0].confidence > 0.94 && result.anchors[0].confidence < 0.96);
});

test("cacheable semantics-unavailable results preserve the registered page and do not rerun on warm cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-semantic-fallback-"));
  try {
    const cache = new FileArtifactCache(root);
    let semanticCalls = 0;
    const processors = {
      renderPage: async ({ document }) => ({ sha256: `page-${document.sha256}`, width: 1000, height: 1000, dpi: 120 }),
      extractSemantics: async () => {
        semanticCalls += 1;
        return {
          anchors: [], lines: [], text: "", sha256: "semantic-unavailable",
          engine: "semantic-unavailable-v1", unavailable: true, errorCode: "PLANNING_TOOL_TIMEOUT"
        };
      },
      resolveStrongGeoreference: async () => ({
        status: "accepted",
        method: "explicit-control-points",
        directAuthority: true,
        confidence: 1,
        pageWidth: 1000,
        pageHeight: 1000,
        points: [
          { x: 0, y: 0, longitude: -1.897, latitude: 52.996 },
          { x: 1000, y: 0, longitude: -1.869, latitude: 52.996 },
          { x: 0, y: 1000, longitude: -1.897, latitude: 52.981 }
        ]
      }),
      registerPage: async () => { throw new Error("visual fallback must not run"); },
      vectorizePage: async () => ({ vectors: [] })
    };
    const args = {
      documents: [{ id: "doc", sha256: "doc", applicationReference: "APP/1", pages: [1] }],
      cache,
      processors,
      bbox: [52.981, -1.897, 52.996, -1.869],
      options: { enforceAuthorityGate: false, extractorVersion: "semantic-cache-fallback-test" }
    };
    const cold = await runPlanningFastPath(args);
    const warm = await runPlanningFastPath(args);
    assert.deepEqual(cold.georeference.candidateAcceptedIds, ["doc"]);
    assert.deepEqual(warm.georeference.candidateAcceptedIds, ["doc"]);
    assert.deepEqual(cold.georeference.acceptedIds, []);
    assert.deepEqual(warm.georeference.acceptedIds, []);
    assert.equal(semanticCalls, 1);
    assert.equal(warm.metrics.semanticHits, 1);
    assert.equal(cold.metrics.pageFailures, 0);
    assert.equal(warm.metrics.pageFailures, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
