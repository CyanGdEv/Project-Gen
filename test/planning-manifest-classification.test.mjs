import test from "node:test";
import assert from "node:assert/strict";
import { classifyPlanningDocument, PLANNING_PREFETCH_INGEST_VERSION } from "../src/sources/planning-prefetch.mjs";

test("planning classifier consumes reference-manifest text and explicit geometry role fields", () => {
  assert.equal(PLANNING_PREFETCH_INGEST_VERSION, 2);
  assert.deepEqual(classifyPlanningDocument({
    applicationMetadata: { text: "Topographical Survey", role: "terrain-or-drainage" }
  }), {
    classification: "drainage-water",
    priority: 90,
    narrative: false
  });

  assert.deepEqual(classifyPlanningDocument({
    applicationMetadata: { text: "Proposed Coaster Track Layout", role: "ride-layout" }
  }), {
    classification: "ride-layout",
    priority: 150,
    narrative: false
  });

  assert.deepEqual(classifyPlanningDocument({ applicationMetadata: { text: "Topographical Survey" } }), {
    classification: "topographical-survey",
    priority: 112,
    narrative: false
  });
});

test("reference-manifest reports remain narrative unless an explicit geometry role says otherwise", () => {
  const report = classifyPlanningDocument({ applicationMetadata: { text: "Drainage Assessment Report" } });
  assert.equal(report.classification, "narrative");
  assert.equal(report.narrative, true);

  const roleBacked = classifyPlanningDocument({ applicationMetadata: { text: "Drainage Assessment Report", role: "terrain-or-drainage" } });
  assert.equal(roleBacked.classification, "drainage-water");
  assert.equal(roleBacked.narrative, false);

  const statement = classifyPlanningDocument({ applicationMetadata: { text: "Planning Statement" } });
  assert.equal(statement.classification, "narrative");
  assert.equal(statement.narrative, true);
});
