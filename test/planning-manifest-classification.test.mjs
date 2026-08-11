import test from "node:test";
import assert from "node:assert/strict";
import { classifyPlanningDocument, PLANNING_PREFETCH_INGEST_VERSION } from "../src/sources/planning-prefetch.mjs";

test("planning classifier consumes reference-manifest text and role fields", () => {
  assert.equal(PLANNING_PREFETCH_INGEST_VERSION, 2);
  assert.deepEqual(classifyPlanningDocument({
    applicationMetadata: { text: "Topographical Survey", role: "terrain-or-drainage" }
  }), {
    classification: "topographical-survey",
    priority: 112,
    narrative: false
  });

  assert.deepEqual(classifyPlanningDocument({
    applicationMetadata: { text: "Proposed Coaster Track Layout", role: "ride-layout" }
  }), {
    classification: "ride-layout",
    priority: 150,
    narrative: false
  });
});

test("reference-manifest report text remains narrative when no geometry role is present", () => {
  const result = classifyPlanningDocument({ applicationMetadata: { text: "Drainage Assessment Report" } });
  assert.equal(result.classification, "drainage-water");
  assert.equal(result.narrative, false);

  const statement = classifyPlanningDocument({ applicationMetadata: { text: "Planning Statement" } });
  assert.equal(statement.classification, "narrative");
  assert.equal(statement.narrative, true);
});
