import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPlanningAuthority, resolveEvidence } from "../src/authority.mjs";
import { contentKey, FileArtifactCache } from "../src/cache.mjs";
import { GENERATION_BUDGET_MS, validateBudget } from "../src/budget.mjs";
import { runTaskGraph } from "../src/task-graph.mjs";

function feature(authorityKey, featureClass, source, confidence = 1) {
  return {
    type: "Feature",
    properties: { authorityKey, featureClass, source, confidence },
    geometry: { type: "Point", coordinates: [0, 0] }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("planning geometry beats OSM for a path", () => {
  const input = [
    feature("path:wickerman:01", "path", "osm", 1),
    feature("path:wickerman:01", "path", "planning", 0.87)
  ];
  const result = resolveEvidence(input);
  assert.equal(result.decisions[0].winnerSource, "planning");
  assert.equal(result.decisions[0].planningLocked, true);
  assert.equal(assertPlanningAuthority(input, result), true);
});

test("planning material cannot be repainted by OSM", () => {
  const input = [
    feature("material:path:01", "path-material", "planning", 0.9),
    feature("material:path:01", "path-material", "osm", 1)
  ];
  assert.equal(resolveEvidence(input).decisions[0].winnerSource, "planning");
});

test("fallback sources remain usable when planning is absent", () => {
  const input = [
    feature("building:01", "building", "osm", 0.9),
    feature("building:01", "building", "microsoft-buildings", 0.8)
  ];
  assert.equal(resolveEvidence(input).decisions[0].winnerSource, "microsoft-buildings");
});

test("content keys are deterministic across object key order", () => {
  assert.equal(contentKey("planning", { b: 2, a: 1 }), contentKey("planning", { a: 1, b: 2 }));
});

test("artifact cache reuses expensive results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-cache-"));
  try {
    const cache = new FileArtifactCache(root);
    const key = contentKey("planning", { sha256: "abc", engine: 1 });
    let calls = 0;
    const first = await cache.getOrCreate(key, async () => ({ value: ++calls }));
    const second = await cache.getOrCreate(key, async () => ({ value: ++calls }));
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(second.value.value, 1);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent acquisition tasks run concurrently", async () => {
  const result = await runTaskGraph([
    { id: "planning", run: async () => { await sleep(50); return 1; } },
    { id: "lidar", run: async () => { await sleep(50); return 2; } },
    { id: "osm", run: async () => { await sleep(50); return 3; } },
    { id: "fusion", deps: ["planning", "lidar", "osm"], run: async ({ deps }) => deps.planning + deps.lidar + deps.osm }
  ], { concurrency: 4, deadlineMs: 1000 });

  assert.equal(result.results.fusion, 6);
  assert.ok(result.durationMs < 140, `expected parallel execution, got ${result.durationMs}ms`);
});

test("default phase plan fits the five-minute generation budget", () => {
  const result = validateBudget();
  assert.equal(result.totalMs, GENERATION_BUDGET_MS);
  assert.ok(result.allocatedMs <= GENERATION_BUDGET_MS);
});
