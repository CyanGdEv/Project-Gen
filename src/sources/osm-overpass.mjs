import { createHttpJsonAdapter } from "./http-json.mjs";

export const OSM_OVERPASS_ADAPTER_VERSION = 1;

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

export function createOsmOverpassAdapter(options = {}) {
  if (!options.endpoint) throw new Error("OSM Overpass adapter requires endpoint");
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("OSM Overpass endpoint must use HTTPS");
  return createHttpJsonAdapter({
    id: "osm",
    freshForMs: options.freshForMs ?? 6 * 60 * 60 * 1000,
    maxBytes: options.maxBytes ?? 40 * 1024 * 1024,
    cache: options.cache,
    fetchImpl: options.fetchImpl,
    buildRequest(request) {
      const query = buildThemeParkOverpassQuery(request.bbox);
      return {
        url: endpoint.toString(),
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          accept: "application/json"
        },
        body: `data=${encodeURIComponent(query)}`
      };
    }
  });
}
