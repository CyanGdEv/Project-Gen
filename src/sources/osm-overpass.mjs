import { createHttpJsonAdapter } from "./http-json.mjs";

export const OSM_OVERPASS_ADAPTER_VERSION = 2;
export const DEFAULT_OVERPASS_USER_AGENT = "Project-Gen/0.1 (+https://github.com/CyanGdEv/Project-Gen)";
export const DEFAULT_OVERPASS_REFERER = "https://github.com/CyanGdEv/Project-Gen";
export const DEFAULT_OSM_STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1000;

function finiteCoordinate(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`invalid ${name}`);
  return number;
}

export function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error("bbox must be [south, west, north, east]");
  const south = finiteCoordinate(bbox[0], "south", -90, 90);
  const west = finiteCoordinate(bbox[1], "west", -180, 180);
  const north = finiteCoordinate(bbox[2], "north", -90, 90);
  const east = finiteCoordinate(bbox[3], "east", -180, 180);
  if (south >= north) throw new Error("bbox south must be below north");
  if (west >= east) throw new Error("bbox west must be left of east");
  const area = (north - south) * (east - west);
  if (area > 0.25) throw new Error("bbox exceeds bounded OSM acquisition ceiling");
  return [south, west, north, east];
}

export function buildThemeParkOverpassQuery(bbox) {
  const [south, west, north, east] = normalizeBbox(bbox);
  const box = `${south},${west},${north},${east}`;
  return `[out:json][timeout:25];\n(\n  nwr["highway"](${box});\n  nwr["building"](${box});\n  nwr["barrier"](${box});\n  nwr["natural"](${box});\n  nwr["water"](${box});\n  nwr["waterway"](${box});\n  nwr["landuse"](${box});\n  nwr["leisure"](${box});\n  nwr["tourism"](${box});\n  nwr["attraction"](${box});\n  nwr["railway"](${box});\n  nwr["man_made"](${box});\n);\nout body geom qt;`;
}

function normalizeEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:") throw new Error("OSM Overpass endpoint must use HTTPS");
  return endpoint.toString();
}

export function normalizeOverpassEndpoints(endpoint, fallbackEndpoints = []) {
  if (!endpoint) throw new Error("OSM Overpass adapter requires endpoint");
  const seen = new Set();
  const output = [];
  for (const value of [endpoint, ...(fallbackEndpoints || [])]) {
    if (!value) continue;
    const normalized = normalizeEndpoint(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function endpointAdapter(endpoint, options = {}) {
  return createHttpJsonAdapter({
    id: "osm",
    freshForMs: options.freshForMs ?? 6 * 60 * 60 * 1000,
    staleIfErrorMs: options.staleIfErrorMs ?? DEFAULT_OSM_STALE_IF_ERROR_MS,
    maxBytes: options.maxBytes ?? 40 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 25000,
    cache: options.cache,
    fetchImpl: options.fetchImpl,
    buildRequest(request) {
      const query = buildThemeParkOverpassQuery(request.bbox);
      return {
        url: endpoint,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          accept: "application/json",
          "user-agent": options.userAgent || DEFAULT_OVERPASS_USER_AGENT,
          referer: options.referer || DEFAULT_OVERPASS_REFERER
        },
        body: `data=${encodeURIComponent(query)}`
      };
    }
  });
}

export function createOsmOverpassAdapter(options = {}) {
  const endpoints = normalizeOverpassEndpoints(options.endpoint, options.fallbackEndpoints);
  const adapters = endpoints.map((endpoint) => ({ endpoint, adapter: endpointAdapter(endpoint, options) }));
  return Object.freeze({
    id: "osm",
    endpoints,
    async acquire(context = {}) {
      const failures = [];
      for (const { endpoint, adapter } of adapters) {
        try {
          const result = await adapter.acquire(context);
          return {
            ...result,
            provenance: {
              ...(result.provenance || {}),
              endpoint,
              endpointAttempt: failures.length + 1,
              attemptedEndpoints: [...failures.map((failure) => failure.endpoint), endpoint]
            }
          };
        } catch (error) {
          failures.push({ endpoint, message: error?.message || String(error) });
        }
      }
      const summary = failures.map((failure) => `${failure.endpoint}: ${failure.message}`).join(" | ");
      const error = new Error(`osm source failed across ${failures.length} endpoint(s): ${summary}`);
      error.code = "OSM_REFERENCE_UNAVAILABLE";
      error.failures = failures;
      throw error;
    }
  });
}
