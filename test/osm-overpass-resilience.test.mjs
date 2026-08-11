import test from "node:test";
import assert from "node:assert/strict";
import {
  createOsmOverpassAdapter,
  DEFAULT_OVERPASS_REFERER,
  DEFAULT_OVERPASS_USER_AGENT,
  normalizeOverpassEndpoints
} from "../src/sources/osm-overpass.mjs";

test("Overpass requests identify Project Gen and preserve form-encoded POST", async () => {
  let captured = null;
  const adapter = createOsmOverpassAdapter({
    endpoint: "https://overpass.example.test/api/interpreter",
    freshForMs: 0,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), ...options };
      return new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 });
    }
  });
  const result = await adapter.acquire({ request: { bbox: [52.981, -1.897, 52.996, -1.869] } });
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers["content-type"], "application/x-www-form-urlencoded; charset=UTF-8");
  assert.equal(captured.headers.accept, "application/json");
  assert.equal(captured.headers["user-agent"], DEFAULT_OVERPASS_USER_AGENT);
  assert.equal(captured.headers.referer, DEFAULT_OVERPASS_REFERER);
  assert.match(captured.body, /^data=/);
  assert.equal(result.provenance.endpointAttempt, 1);
});

test("Overpass acquisition falls through to the next bounded endpoint", async () => {
  const seen = [];
  const adapter = createOsmOverpassAdapter({
    endpoint: "https://primary.example.test/api/interpreter",
    fallbackEndpoints: ["https://fallback.example.test/api/interpreter"],
    freshForMs: 0,
    fetchImpl: async (url) => {
      seen.push(String(url));
      if (String(url).includes("primary")) return new Response("Not acceptable", { status: 406 });
      return new Response(JSON.stringify({ version: 0.6, elements: [{ type: "node", id: 1 }] }), { status: 200 });
    }
  });
  const result = await adapter.acquire({ request: { bbox: [52.981, -1.897, 52.996, -1.869] } });
  assert.deepEqual(seen, [
    "https://primary.example.test/api/interpreter",
    "https://fallback.example.test/api/interpreter"
  ]);
  assert.equal(result.provenance.endpointAttempt, 2);
  assert.equal(result.provenance.endpoint, "https://fallback.example.test/api/interpreter");
  assert.deepEqual(result.provenance.attemptedEndpoints, seen);
});

test("Overpass endpoint list is HTTPS-only and de-duplicated", () => {
  assert.deepEqual(normalizeOverpassEndpoints(
    "https://primary.example/api/interpreter",
    ["https://primary.example/api/interpreter", "https://fallback.example/api/interpreter"]
  ), [
    "https://primary.example/api/interpreter",
    "https://fallback.example/api/interpreter"
  ]);
  assert.throws(() => normalizeOverpassEndpoints("http://unsafe.example/api/interpreter"), /must use HTTPS/);
});
