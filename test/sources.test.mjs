import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileArtifactCache } from "../src/cache.mjs";
import { assertReferenceSourceParity, REFERENCE_SOURCE_IDS, SOURCE_CATALOG, worldRenderableSourceIds } from "../src/source-catalog.mjs";
import { acquireSources } from "../src/source-runtime.mjs";
import { createHttpJsonAdapter } from "../src/sources/http-json.mjs";
import { buildThemeParkOverpassQuery, createOsmOverpassAdapter, normalizeBbox } from "../src/sources/osm-overpass.mjs";
import {
  classifyPlanningDocument,
  createPlanningPrefetchAdapter,
  ingestPlanningPrefetch,
  planningEvidenceKey
} from "../src/sources/planning-prefetch.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixturePlanningPrefetch() {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-planning-"));
  await mkdir(path.join(root, "files"), { recursive: true });
  const sitePlan = Buffer.from("%PDF-1.4\nproposed site plan\n");
  const statement = Buffer.from("%PDF-1.4\nplanning statement\n");
  await writeFile(path.join(root, "files/site-plan.pdf"), sitePlan);
  await writeFile(path.join(root, "files/statement.pdf"), statement);
  const siteUrl = "https://planning.example.gov/documents/site-plan";
  const statementUrl = "https://planning.example.gov/documents/statement";
  const manifest = {
    schemaVersion: 1,
    status: "usable",
    generatedAt: "2026-08-11T08:00:00.000Z",
    runner: "linux-native",
    tlsVerification: "verified-native",
    liveApplications: 1,
    documentsDownloaded: 2,
    applications: [{
      reference: "TP/2026/0001",
      downloadedDocuments: [
        { url: siteUrl, title: "Proposed Site Plan" },
        { url: statementUrl, title: "Planning Statement" }
      ]
    }],
    entries: [
      { kind: "document", url: statementUrl, file: "files/statement.pdf", bytes: statement.length, sha256: sha256(statement), mime: "application/pdf" },
      { kind: "document", url: siteUrl, file: "files/site-plan.pdf", bytes: sitePlan.length, sha256: sha256(sitePlan), mime: "application/pdf" }
    ]
  };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, manifest };
}

test("planning documents are classified geometry-first", () => {
  assert.deepEqual(classifyPlanningDocument({ title: "Proposed Site Plan" }), {
    classification: "site-plan",
    priority: 130,
    narrative: false
  });
  assert.equal(classifyPlanningDocument({ title: "Planning Statement" }).narrative, true);
});

test("planning prefetch ingestion verifies bytes and ranks drawings before narrative documents", async () => {
  const fixture = await fixturePlanningPrefetch();
  try {
    const result = await ingestPlanningPrefetch(fixture.root);
    assert.equal(result.status, "usable");
    assert.equal(result.documents.length, 2);
    assert.equal(result.documents[0].classification, "site-plan");
    assert.equal(result.documents[1].classification, "narrative");
    assert.equal(result.stats.geometryFirst, 1);
    assert.equal(result.stats.narrative, 1);
    assert.equal(result.evidenceKey, planningEvidenceKey(fixture.manifest));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("planning prefetch cache avoids rehashing unchanged evidence", async () => {
  const fixture = await fixturePlanningPrefetch();
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "project-gen-planning-cache-"));
  try {
    const cache = new FileArtifactCache(cacheRoot);
    const first = await ingestPlanningPrefetch(fixture.root, { cache });
    const second = await ingestPlanningPrefetch(fixture.root, { cache });
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.deepEqual(second.documents.map((entry) => entry.sha256), first.documents.map((entry) => entry.sha256));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("planning evidence key ignores volatile manifest timestamps", () => {
  const base = {
    schemaVersion: 1,
    status: "usable",
    entries: [{ kind: "document", url: "https://planning.example/doc", file: "files/a.pdf", bytes: 10, sha256: "a".repeat(64), mime: "application/pdf" }],
    applications: []
  };
  assert.equal(
    planningEvidenceKey({ ...base, generatedAt: "2026-01-01T00:00:00Z" }),
    planningEvidenceKey({ ...base, generatedAt: "2026-08-11T00:00:00Z", selectedAt: "later" })
  );
});

test("HTTP JSON adapter serves fresh cached evidence without a network request", async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "project-gen-http-cache-"));
  try {
    const cache = new FileArtifactCache(cacheRoot);
    let requests = 0;
    const adapter = createHttpJsonAdapter({
      id: "osm",
      freshForMs: 60_000,
      buildRequest: () => ({ url: "https://example.test/osm.json" }),
      fetchImpl: async () => {
        requests += 1;
        return new Response(JSON.stringify({ elements: [1, 2, 3] }), {
          status: 200,
          headers: { etag: '"v1"', "content-type": "application/json" }
        });
      }
    });
    const first = await adapter.acquire({ cache, now: 10_000 });
    const second = await adapter.acquire({ cache, now: 20_000 });
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(second.cacheMode, "fresh");
    assert.equal(requests, 1);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("HTTP JSON adapter revalidates stale evidence with ETag", async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "project-gen-http-revalidate-"));
  try {
    const cache = new FileArtifactCache(cacheRoot);
    const seenHeaders = [];
    let requests = 0;
    const adapter = createHttpJsonAdapter({
      id: "lidar-index",
      freshForMs: 5,
      buildRequest: () => ({ url: "https://example.test/lidar.json" }),
      fetchImpl: async (_url, options) => {
        requests += 1;
        seenHeaders.push(options.headers);
        if (requests === 1) {
          return new Response(JSON.stringify({ tiles: ["A"] }), { status: 200, headers: { etag: '"tile-v1"' } });
        }
        return new Response(null, { status: 304 });
      }
    });
    await adapter.acquire({ cache, now: 1_000 });
    const second = await adapter.acquire({ cache, now: 2_000 });
    assert.equal(second.cacheHit, true);
    assert.equal(second.cacheMode, "revalidated");
    assert.equal(seenHeaders[1]["if-none-match"], '"tile-v1"');
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("source runtime runs planning and remote adapters concurrently and supports fail-open optional sources", async () => {
  const fixture = await fixturePlanningPrefetch();
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "project-gen-source-runtime-"));
  try {
    const cache = new FileArtifactCache(cacheRoot);
    const planning = createPlanningPrefetchAdapter({ directory: fixture.root });
    const osm = createHttpJsonAdapter({
      id: "osm",
      freshForMs: 0,
      buildRequest: () => ({ url: "https://example.test/osm.json" }),
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      }
    });
    const optional = {
      id: "openaerialmap",
      async acquire() {
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw new Error("provider unavailable");
      }
    };
    const result = await acquireSources([planning, osm, optional], { bbox: [0, 0, 1, 1] }, {
      cache,
      concurrency: 3,
      deadlineMs: 1000,
      failOpen: ["openaerialmap"]
    });
    assert.equal(result.sources.planning.status, "usable");
    assert.equal(result.sources.osm.status, "usable");
    assert.equal(result.sources.openaerialmap.status, "unavailable");
    assert.ok(result.durationMs < 100, `expected concurrent acquisition, got ${result.durationMs}ms`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("source catalog retains provider parity while forbidding OSM world rendering", () => {
  assert.equal(SOURCE_CATALOG.planning.role, "primary-geometry-material-authority");
  assert.equal(SOURCE_CATALOG.planning.worldRenderable, true);
  assert.equal(SOURCE_CATALOG.osm.role, "registration-placement-reference-only-never-rendered");
  assert.equal(SOURCE_CATALOG.osm.worldRenderable, false);
  assert.equal(worldRenderableSourceIds().includes("osm"), false);
  assert.equal(assertReferenceSourceParity(REFERENCE_SOURCE_IDS).complete, true);
});

test("OSM adapter emits a bounded theme-park query and never changes planning authority semantics", async () => {
  assert.deepEqual(normalizeBbox([52.98, -1.9, 53.0, -1.86]), [52.98, -1.9, 53, -1.86]);
  const query = buildThemeParkOverpassQuery([52.98, -1.9, 53.0, -1.86]);
  assert.match(query, /nwr\["highway"\]/);
  assert.match(query, /nwr\["building"\]/);
  assert.match(query, /out body geom qt/);

  let postedBody = null;
  const adapter = createOsmOverpassAdapter({
    endpoint: "https://overpass.example.test/api/interpreter",
    freshForMs: 0,
    fetchImpl: async (_url, options) => {
      postedBody = options.body;
      return new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 });
    }
  });
  const result = await adapter.acquire({ request: { bbox: [52.98, -1.9, 53.0, -1.86] } });
  assert.equal(result.source, "osm");
  assert.match(postedBody, /^data=/);
});
