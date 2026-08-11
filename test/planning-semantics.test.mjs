import test from "node:test";
import assert from "node:assert/strict";
import { attachSemanticRoles, classifyPlanningSemanticLabel, extractSemanticAnchorsFromTsv } from "../src/planning/semantics.mjs";

test("planning semantic label classifier covers high-value site features", () => {
  assert.equal(classifyPlanningSemanticLabel("Proposed raised footbridde and path"), "site-path-centerline-candidate");
  assert.equal(classifyPlanningSemanticLabel("New roller coaster track layout"), "ride-layout-candidate");
  assert.equal(classifyPlanningSemanticLabel("Track support column bases"), "ride-support-candidate");
  assert.equal(classifyPlanningSemanticLabel("Retaining wall"), "wall-candidate");
  assert.equal(classifyPlanningSemanticLabel("Existing pond"), "water-candidate");
});

test("tesseract TSV is grouped into semantic line anchors", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t100\t200\t70\t20\t92\tProposed",
    "5\t1\t1\t1\t1\t2\t175\t200\t40\t20\t91\tpath",
    "5\t1\t1\t1\t2\t1\t500\t600\t50\t20\t95\tNotes"
  ].join("\n");
  const result = extractSemanticAnchorsFromTsv(tsv);
  assert.equal(result.anchors.length, 1);
  assert.equal(result.anchors[0].role, "site-path-centerline-candidate");
  assert.equal(result.anchors[0].bounds.left, 100);
  assert.ok(result.sha256.length === 64);
});

test("semantic anchors annotate nearby linework candidates", () => {
  const result = attachSemanticRoles([
    { id: "near", pageBounds: { left: 100, top: 100, width: 20, height: 20 }, geometry: { type: "LineString", coordinates: [] } },
    { id: "far", pageBounds: { left: 900, top: 900, width: 20, height: 20 }, geometry: { type: "LineString", coordinates: [] } }
  ], [{ role: "fence-candidate", text: "security fence", confidence: 0.9, bounds: { centerX: 115, centerY: 112 } }], { maxDistancePx: 100 });
  assert.equal(result[0].role, "fence-candidate");
  assert.equal(result[0].properties.planning_semantic, true);
  assert.equal(result[1].role, undefined);
});
