import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileArtifactCache } from "../src/cache.mjs";
import { createHttpJsonAdapter } from "../src/sources/http-json.mjs";

test("HTTP JSON adapter serves previously verified stale evidence after a transient source failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-stale-source-"));
  try {
    const cache = new FileArtifactCache(root);
    let requests = 0;
    const adapter = createHttpJsonAdapter({
      id: "osm",
      freshForMs: 5,
      staleIfErrorMs: 10_000,
      buildRequest: () => ({ url: "https://example.test/overpass" }),
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) {
          return new Response(JSON.stringify({ version: 0.6, elements: [{ id: 1 }] }), {
            status: 200,
            headers: { etag: '"osm-v1"' }
          });
        }
        throw new Error("transient upstream timeout");
      }
    });

    const cold = await adapter.acquire({ cache, now: 1_000 });
    const fallback = await adapter.acquire({ cache, now: 2_000 });

    assert.equal(cold.cacheMode, "miss");
    assert.equal(fallback.cacheHit, true);
    assert.equal(fallback.cacheMode, "stale-if-error");
    assert.equal(fallback.payload.elements[0].id, 1);
    assert.equal(fallback.provenance.staleAgeMs, 1_000);
    assert.match(fallback.provenance.staleReason, /transient upstream timeout/);
    assert.equal(requests, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP JSON adapter does not serve stale evidence beyond the configured safety window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-expired-source-"));
  try {
    const cache = new FileArtifactCache(root);
    let requests = 0;
    const adapter = createHttpJsonAdapter({
      id: "osm",
      freshForMs: 5,
      staleIfErrorMs: 100,
      buildRequest: () => ({ url: "https://example.test/overpass" }),
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) return new Response(JSON.stringify({ elements: [] }), { status: 200 });
        throw new Error("source unavailable");
      }
    });

    await adapter.acquire({ cache, now: 1_000 });
    await assert.rejects(adapter.acquire({ cache, now: 2_000 }), /source unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
