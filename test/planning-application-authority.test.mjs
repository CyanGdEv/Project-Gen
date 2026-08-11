import test from "node:test";
import assert from "node:assert/strict";
import { resolveEvidence } from "../src/authority.mjs";
import { evaluatePlanningAuthority } from "../src/planning/authority-gate.mjs";
import {
  normalizePlanningApplicationStatus,
  planningApplicationWorldAuthorityEligible
} from "../src/planning/authority-status.mjs";
import { normalizePlanningVectors } from "../src/planning/vectorize.mjs";

function pathFeature(source, authorityKey, extra = {}) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    properties: { source, featureClass: "path", authorityKey, confidence: 1, ...extra }
  };
}

const candidate = {
  directAuthority: true,
  confidence: 1,
  pageWidth: 1000,
  pageHeight: 1000,
  points: [
    { x: 0, y: 0, longitude: -1.897, latitude: 52.996 },
    { x: 1000, y: 0, longitude: -1.869, latitude: 52.996 },
    { x: 0, y: 1000, longitude: -1.897, latitude: 52.981 }
  ]
};

test("planning application status eligibility is conservative", () => {
  assert.equal(normalizePlanningApplicationStatus(" Planning Permission - Approved "), "planning permission - approved");
  assert.equal(planningApplicationWorldAuthorityEligible("approved"), true);
  assert.equal(planningApplicationWorldAuthorityEligible("Planning Permission - Approved"), true);
  assert.equal(planningApplicationWorldAuthorityEligible("withdrawn"), false);
  assert.equal(planningApplicationWorldAuthorityEligible("awaiting decision"), false);
  assert.equal(planningApplicationWorldAuthorityEligible("unknown"), false);
});

test("final planning authority gate rejects withdrawn and unknown applications", () => {
  const approved = evaluatePlanningAuthority(candidate, {
    applicationStatus: "approved",
    bbox: [52.981, -1.897, 52.996, -1.869]
  });
  assert.equal(approved.accepted, true);

  for (const applicationStatus of ["withdrawn", "unknown", "awaiting decision"]) {
    const result = evaluatePlanningAuthority(candidate, {
      applicationStatus,
      bbox: [52.981, -1.897, 52.996, -1.869]
    });
    assert.equal(result.accepted, false);
    assert.ok(result.reasons.includes("application-status-not-world-authority-eligible"));
  }
});

test("status-less synthetic authority-gate fixtures remain backward compatible", () => {
  const result = evaluatePlanningAuthority(candidate, { bbox: [52.981, -1.897, 52.996, -1.869] });
  assert.equal(result.applicationStatus, null);
  assert.equal(result.applicationStatusEligible, true);
  assert.equal(result.accepted, true);
});

test("withdrawn planning evidence does not lock out fallback world evidence", () => {
  const key = "path:status-test";
  const withdrawnPlanning = pathFeature("planning", key, { planningWorldAuthorityEligible: false });
  const osm = pathFeature("osm", key, { confidence: 0.8 });
  const result = resolveEvidence([withdrawnPlanning, osm]);
  assert.equal(result.winners[0].properties.source, "osm");
  assert.equal(result.decisions[0].planningLocked, false);
  assert.equal(result.decisions[0].planningEvidenceCount, 1);
  assert.equal(result.decisions[0].eligiblePlanningCount, 0);
});

test("approved normalized planning vectors carry world-authority eligibility provenance", () => {
  const approved = normalizePlanningVectors([
    { role: "site-path-centerline-candidate", geometry: { type: "LineString", coordinates: [[-1.89, 52.99], [-1.88, 52.985]] } }
  ], { applicationReference: "APP/1", applicationStatus: "approved", confidence: 0.95 });
  const withdrawn = normalizePlanningVectors([
    { role: "site-path-centerline-candidate", geometry: { type: "LineString", coordinates: [[-1.89, 52.99], [-1.88, 52.985]] } }
  ], { applicationReference: "APP/2", applicationStatus: "withdrawn", confidence: 0.95 });
  assert.equal(approved.features[0].properties.planningWorldAuthorityEligible, true);
  assert.equal(approved.features[0].properties.planningApplicationStatus, "approved");
  assert.equal(withdrawn.features[0].properties.planningWorldAuthorityEligible, false);
  assert.equal(withdrawn.features[0].properties.planningApplicationStatus, "withdrawn");
});
