import test from "node:test";
import assert from "node:assert/strict";
import { bridgePlanningForPinnedVme, PINNED_VME_COMPILER } from "../src/world/vme-planning-bridge.mjs";

function feature(id, featureClass, overrides = {}) {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: [[-1.89, 52.98], [-1.88, 52.99]] },
    properties: {
      source: "planning",
      featureClass,
      planningWorldAuthority: true,
      osmWorldRenderable: false,
      authorityKey: `${featureClass}:test:${id}`,
      applicationReference: "SMD/2016/0315",
      documentId: `planning:${id}`,
      sourceSha256: id.repeat(64).slice(0, 64),
      page: 1,
      ...overrides
    }
  };
}

test("pinned VME bridge preserves proven planning geometry and provenance exactly", () => {
  const building = feature("a", "building");
  const path = feature("b", "path", { surface: "planning-only" });
  const input = { type: "FeatureCollection", name: "project-gen", features: [building, path] };
  const { featureCollection, report } = bridgePlanningForPinnedVme(input);
  assert.deepEqual(featureCollection.features, input.features);
  assert.equal(featureCollection.name, "project-gen");
  assert.equal(report.inputFeatures, 2);
  assert.equal(report.outputFeatures, 2);
  assert.equal(report.withheldFeatures, 0);
  assert.equal(report.compiler.sha, PINNED_VME_COMPILER.sha);
  assert.equal(report.planningAuthorityPreserved, true);
  assert.equal(report.osmWorldRenderable, false);
});

test("terrain-detail is withheld for the pinned compiler without semantic relabelling", () => {
  const terrain = feature("c", "terrain-detail");
  const water = feature("d", "water");
  const input = { type: "FeatureCollection", features: [terrain, water] };
  const { featureCollection, report } = bridgePlanningForPinnedVme(input);
  assert.deepEqual(featureCollection.features, [water]);
  assert.equal(report.withheldFeatures, 1);
  assert.deepEqual(report.withheldByClass, { "terrain-detail": 1 });
  assert.equal(report.withheld[0].featureClass, "terrain-detail");
  assert.equal(report.withheld[0].reason, "unsupported-by-pinned-vme-external-planning-contract");
  assert.equal(report.withheld[0].authorityKey, terrain.properties.authorityKey);
});

test("bridge fails closed on an unreviewed future planning semantic class", () => {
  const input = { type: "FeatureCollection", features: [feature("e", "ride-layout")] };
  assert.throws(() => bridgePlanningForPinnedVme(input), /unreviewed planning semantic class.*ride-layout/i);
});

test("bridge refuses non-planning or OSM-renderable geometry", () => {
  assert.throws(() => bridgePlanningForPinnedVme({
    type: "FeatureCollection",
    features: [feature("f", "path", { source: "osm" })]
  }), /refuses non-planning/i);
  assert.throws(() => bridgePlanningForPinnedVme({
    type: "FeatureCollection",
    features: [feature("g", "path", { osmWorldRenderable: true })]
  }), /refuses OSM-renderable/i);
});
