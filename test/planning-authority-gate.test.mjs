import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePlanningAuthority, planningGeofenceOverlap } from "../src/planning/authority-gate.mjs";

function candidateFromExtent({ west, south, east, north, confidence = 0.9, offsetM = 10, directAuthority = false }) {
  return {
    pageWidth: 100,
    pageHeight: 100,
    confidence,
    directAuthority,
    candidateLocation: { longitude: (west + east) / 2, latitude: (south + north) / 2 },
    quality: offsetM == null ? {} : { locationOffsetM: offsetM },
    points: [
      { x: 0, y: 0, longitude: west, latitude: north },
      { x: 100, y: 0, longitude: east, latitude: north },
      { x: 100, y: 100, longitude: east, latitude: south },
      { x: 0, y: 100, longitude: west, latitude: south }
    ]
  };
}

const approved = Object.freeze({ applicationStatus: "approved" });

test("planning authority overlap projects the full drawing extent into the build geofence", () => {
  const bbox = [0, 0, 1, 1];
  const inside = candidateFromExtent({ west: 0, south: 0, east: 1, north: 1 });
  assert.ok(Math.abs(planningGeofenceOverlap(inside, bbox) - 1) < 1e-9);

  const tenPercent = candidateFromExtent({ west: -9, south: 0, east: 1, north: 1 });
  assert.ok(Math.abs(planningGeofenceOverlap(tenPercent, bbox) - 0.1) < 1e-9);
});

test("visual planning authority keeps 0.72 candidate formation separate from the 0.86 final gate", () => {
  const bbox = [0, 0, 1, 1];
  const below = candidateFromExtent({ west: 0, south: 0, east: 1, north: 1, confidence: 0.85, offsetM: 10 });
  const result = evaluatePlanningAuthority(below, { bbox, ...approved });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("confidence-below-authority-gate"));

  const accepted = evaluatePlanningAuthority(candidateFromExtent({ west: 0, south: 0, east: 1, north: 1, confidence: 0.9, offsetM: 10 }), { bbox, ...approved });
  assert.equal(accepted.accepted, true, `unexpected rejection: ${accepted.reasons.join(",")}`);
  assert.equal(accepted.applicationStatusEligible, true);
  assert.equal(accepted.thresholds.minConfidence, 0.86);
  assert.equal(accepted.thresholds.minOverlap, 0.18);
  assert.equal(accepted.thresholds.maxOffsetM, 25);
});

test("visual planning authority rejects insufficient build overlap and excessive registration offset", () => {
  const bbox = [0, 0, 1, 1];
  const lowOverlap = evaluatePlanningAuthority(candidateFromExtent({ west: -9, south: 0, east: 1, north: 1, confidence: 0.95, offsetM: 10 }), { bbox, ...approved });
  assert.equal(lowOverlap.accepted, false);
  assert.ok(lowOverlap.reasons.includes("build-geofence-overlap-below-authority-gate"));

  const highOffset = evaluatePlanningAuthority(candidateFromExtent({ west: 0, south: 0, east: 1, north: 1, confidence: 0.95, offsetM: 25.01 }), { bbox, ...approved });
  assert.equal(highOffset.accepted, false);
  assert.ok(highOffset.reasons.includes("registration-offset-above-authority-gate"));
});

test("strong geospatial controls still require confidence and build overlap but not heuristic location-prior offset", () => {
  const bbox = [0, 0, 1, 1];
  const strong = candidateFromExtent({ west: 0, south: 0, east: 1, north: 1, confidence: 1, offsetM: null, directAuthority: true });
  const result = evaluatePlanningAuthority(strong, { bbox, locationPrior: null, ...approved });
  assert.equal(result.accepted, true, `unexpected rejection: ${result.reasons.join(",")}`);
  assert.equal(result.mode, "strong-georeference");
  assert.equal(result.applicationStatusEligible, true);
  assert.equal(result.offsetM, null);
});

test("non-final application status cannot become world authority even with perfect geometry", () => {
  const bbox = [0, 0, 1, 1];
  const candidate = candidateFromExtent({ west: 0, south: 0, east: 1, north: 1, confidence: 1, offsetM: 0 });
  const result = evaluatePlanningAuthority(candidate, { bbox, applicationStatus: "pending" });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("application-status-not-world-authority-eligible"));
});
