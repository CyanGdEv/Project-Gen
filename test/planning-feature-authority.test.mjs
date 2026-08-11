import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPlanningFeatureAuthority,
  evaluatePlanningFeatureAuthority,
  normalizeOsmReferenceFeatures,
  planningGeometryMatch,
  projectWgs84Geometry
} from "../src/planning/osm-feature-authority.mjs";

const BBOX = [52.98, -1.90, 53.00, -1.86];

function planningLine({
  id = "planning:path:1",
  coordinates = [[-1.8850, 52.9900], [-1.8800, 52.9900]],
  confidence = 0.95,
  status = "approved",
  featureClass = "path"
} = {}) {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates },
    properties: {
      featureClass,
      source: "planning",
      confidence,
      planningApplicationStatus: status,
      planningWorldAuthorityEligible: ["approved", "granted", "permitted"].includes(status),
      applicationReference: "SMD/TEST/1",
      documentId: "planning:doc"
    }
  };
}

function osmPayload(lines) {
  return {
    version: 0.6,
    elements: lines.map((coordinates, index) => ({
      type: "way",
      id: index + 1,
      tags: { highway: "service", name: `Reference ${index + 1}` },
      geometry: coordinates.map(([lon, lat]) => ({ lon, lat }))
    }))
  };
}

test("feature authority accepts equivalent reference geometry but emits planning geometry only", () => {
  const planning = planningLine();
  const references = normalizeOsmReferenceFeatures(osmPayload([planning.geometry.coordinates]), BBOX);
  const result = applyPlanningFeatureAuthority([planning], references, { bbox: BBOX });

  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.accepted[0].geometry, planning.geometry);
  assert.equal(result.accepted[0].properties.source, "planning");
  assert.equal(result.accepted[0].properties.planningWorldAuthority, true);
  assert.equal(result.accepted[0].properties.planningAuthorityAction, "planning-authority-corroborated");
  assert.equal(result.accepted[0].properties.osmWorldRenderable, false);
  assert.match(result.accepted[0].properties.planningValidationTargetId, /^osm:way:/);
});

test("line matcher uses the 25 m displacement radius for feature overlap", () => {
  const planning = planningLine();
  const near = {
    kind: "path",
    name: null,
    localGeometry: projectWgs84Geometry({
      type: "LineString",
      coordinates: planning.geometry.coordinates.map(([lon, lat]) => [lon, lat + 0.0001])
    }, BBOX)
  };
  const far = {
    kind: "path",
    name: null,
    localGeometry: projectWgs84Geometry({
      type: "LineString",
      coordinates: planning.geometry.coordinates.map(([lon, lat]) => [lon, lat + 0.00035])
    }, BBOX)
  };
  const localPlanning = {
    kind: "path",
    name: null,
    localGeometry: projectWgs84Geometry(planning.geometry, BBOX)
  };

  const nearMatch = planningGeometryMatch(localPlanning, near, { maxOffsetM: 25, minOverlap: 0.18 });
  const farMatch = planningGeometryMatch(localPlanning, far, { maxOffsetM: 25, minOverlap: 0.18 });
  assert.equal(Boolean(nearMatch.match), true);
  assert.ok(nearMatch.planningFraction > 0.8);
  assert.equal(Boolean(farMatch.match), false);
});

test("approved high-confidence planning geometry gap-fills when OSM has no compatible target", () => {
  const planning = planningLine({ featureClass: "ride-layout" });
  const evaluation = evaluatePlanningFeatureAuthority(planning, [], { bbox: BBOX, allowGapFill: true });
  assert.equal(evaluation.accepted, true);
  assert.equal(evaluation.action, "planning-authority-gap-fill");
  assert.equal(evaluation.matchedTargetId, null);
});

test("gap-fill can be disabled without changing confidence or geometry thresholds", () => {
  const evaluation = evaluatePlanningFeatureAuthority(planningLine(), [], { bbox: BBOX, allowGapFill: false });
  assert.equal(evaluation.accepted, false);
  assert.deepEqual(evaluation.reasons, ["compatible-reference-target-required"]);
});

test("near-equal compatible reference targets are withheld as ambiguous", () => {
  const planning = planningLine();
  const shiftedA = planning.geometry.coordinates.map(([lon, lat]) => [lon, lat + 0.00003]);
  const shiftedB = planning.geometry.coordinates.map(([lon, lat]) => [lon, lat - 0.00003]);
  const references = normalizeOsmReferenceFeatures(osmPayload([shiftedA, shiftedB]), BBOX);
  const evaluation = evaluatePlanningFeatureAuthority(planning, references, { bbox: BBOX });
  assert.equal(evaluation.accepted, false);
  assert.equal(evaluation.action, "ambiguous-reference-withheld");
  assert.deepEqual(evaluation.reasons, ["ambiguous-compatible-reference-targets"]);
  assert.ok(evaluation.matchedTargetId);
  assert.ok(evaluation.alternateTargetId);
});

test("low-confidence or status-ineligible planning features never become world authority", () => {
  const lowConfidence = evaluatePlanningFeatureAuthority(planningLine({ confidence: 0.859 }), [], { bbox: BBOX });
  assert.equal(lowConfidence.accepted, false);
  assert.ok(lowConfidence.reasons.includes("confidence-below-authority-gate"));

  const pending = evaluatePlanningFeatureAuthority(planningLine({ status: "pending" }), [], { bbox: BBOX });
  assert.equal(pending.accepted, false);
  assert.ok(pending.reasons.includes("application-status-not-world-authority-eligible"));
});

test("raw OSM normalization remains validation-only and never authorizes OSM rendering", () => {
  const references = normalizeOsmReferenceFeatures(osmPayload([[[-1.885, 52.99], [-1.88, 52.99]]]), BBOX);
  assert.equal(references.length, 1);
  assert.equal(references[0].kind, "path");
  assert.equal(references[0].source.provider, "OpenStreetMap");
  assert.equal(references[0].source.role, "planning-validation-reference-only-never-rendered");
  assert.equal("worldRenderable" in references[0].source, false);
});
