import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPlanningFeatureAuthority,
  evaluatePlanningFeatureAuthority,
  normalizeOsmReferenceFeatures
} from "../src/planning/osm-feature-authority.mjs";

const bbox = [52.981, -1.897, 52.996, -1.869];

function planningPath(overrides = {}) {
  return {
    type: "Feature",
    id: "planning:path:1",
    geometry: {
      type: "LineString",
      coordinates: [[-1.889, 52.990], [-1.884, 52.989], [-1.880, 52.987]]
    },
    properties: {
      source: "planning",
      featureClass: "path",
      confidence: 0.97,
      planningApplicationStatus: "approved",
      planningWorldAuthorityEligible: true,
      ...overrides
    }
  };
}

function osmPayload(ids = [10]) {
  return {
    elements: ids.map((id) => ({
      type: "way",
      id,
      tags: { highway: "footway", name: "Benchmark Path" },
      geometry: [
        { lon: -1.889, lat: 52.990 },
        { lon: -1.884, lat: 52.989 },
        { lon: -1.880, lat: 52.987 }
      ]
    }))
  };
}

test("OSM reference normalization marks context as validation-only and non-render authority", () => {
  const references = normalizeOsmReferenceFeatures(osmPayload(), bbox);
  assert.equal(references.length, 1);
  assert.equal(references[0].kind, "path");
  assert.equal(references[0].source.role, "planning-validation-reference-only-never-rendered");
  assert.equal(references[0].id, "osm:way:10");
});

test("approved high-confidence planning geometry is corroborated by an equivalent OSM reference", () => {
  const references = normalizeOsmReferenceFeatures(osmPayload(), bbox);
  const result = evaluatePlanningFeatureAuthority(planningPath(), references, { bbox });
  assert.equal(result.accepted, true);
  assert.equal(result.action, "planning-authority-corroborated");
  assert.equal(result.matchedTargetId, "osm:way:10");
  assert.equal(result.reasons.length, 0);
});

test("feature-level authority never makes the OSM validation target world-renderable", () => {
  const references = normalizeOsmReferenceFeatures(osmPayload(), bbox);
  const result = applyPlanningFeatureAuthority([planningPath()], references, { bbox });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].properties.planningWorldAuthority, true);
  assert.equal(result.accepted[0].properties.osmWorldRenderable, false);
  assert.equal(result.accepted[0].properties.planningValidationTargetId, "osm:way:10");
});

test("withdrawn planning remains evidence but cannot become world authority", () => {
  const references = normalizeOsmReferenceFeatures(osmPayload(), bbox);
  const feature = planningPath({ planningApplicationStatus: "withdrawn", planningWorldAuthorityEligible: false });
  const result = evaluatePlanningFeatureAuthority(feature, references, { bbox });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("application-status-not-world-authority-eligible"));
});

test("two equally strong compatible reference targets are withheld as ambiguous", () => {
  const references = normalizeOsmReferenceFeatures(osmPayload([10, 11]), bbox);
  const result = evaluatePlanningFeatureAuthority(planningPath(), references, { bbox });
  assert.equal(result.accepted, false);
  assert.equal(result.action, "ambiguous-reference-withheld");
  assert.ok(result.reasons.includes("ambiguous-compatible-reference-targets"));
});

test("planning-only gap fill remains allowed when no compatible OSM feature exists", () => {
  const result = evaluatePlanningFeatureAuthority(planningPath(), [], { bbox, allowGapFill: true });
  assert.equal(result.accepted, true);
  assert.equal(result.action, "planning-authority-gap-fill");
  assert.equal(result.matchedTargetId, null);
});
