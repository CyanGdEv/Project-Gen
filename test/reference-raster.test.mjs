import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileArtifactCache } from "../src/cache.mjs";
import { buildPlanningReference } from "../src/planning/reference-raster.mjs";

test("bounded OSM context builds a cacheable registration-only reference raster", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-reference-"));
  try {
    const cache = new FileArtifactCache(path.join(root, "cache"));
    const source = {
      source: "osm",
      payload: {
        elements: [{
          type: "way",
          id: 1,
          tags: { highway: "footway" },
          geometry: [
            { lon: -1.889, lat: 52.990 },
            { lon: -1.880, lat: 52.985 },
            { lon: -1.871, lat: 52.980 }
          ]
        }]
      }
    };
    const options = { size: 512, artifactRoot: path.join(root, "artifacts") };
    const first = await buildPlanningReference({ source, bbox: [52.97, -1.90, 53.00, -1.85], cache, options });
    const second = await buildPlanningReference({ source, bbox: [52.97, -1.90, 53.00, -1.85], cache, options });
    assert.equal(first.role, "registration-context-only");
    assert.equal(first.source, "osm");
    assert.equal(first.features, 1);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(second.sha256, first.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
