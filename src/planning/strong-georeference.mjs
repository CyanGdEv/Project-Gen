function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bboxArray(bbox) {
  if (Array.isArray(bbox) && bbox.length === 4) return bbox.map(Number);
  if (bbox && typeof bbox === "object") return [bbox.south, bbox.west, bbox.north, bbox.east].map(Number);
  return null;
}

function candidateCenter(points) {
  if (!points.length) return null;
  return {
    longitude: points.reduce((sum, point) => sum + point.longitude, 0) / points.length,
    latitude: points.reduce((sum, point) => sum + point.latitude, 0) / points.length
  };
}

function normalizePoint(point) {
  const x = finite(point?.x ?? point?.pixelX ?? point?.pageX);
  const y = finite(point?.y ?? point?.pixelY ?? point?.pageY);
  const longitude = finite(point?.longitude ?? point?.lon ?? point?.lng);
  const latitude = finite(point?.latitude ?? point?.lat);
  if ([x, y, longitude, latitude].some((value) => value === null)) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  return { x, y, longitude, latitude };
}

function expandedBboxContains(point, bbox, paddingM = 1000) {
  const values = bboxArray(bbox);
  if (!values || values.some((value) => !Number.isFinite(value))) return true;
  const [south, west, north, east] = values;
  const midLat = (south + north) / 2;
  const latPad = paddingM / 111320;
  const lonPad = paddingM / Math.max(1000, 111320 * Math.cos(midLat * Math.PI / 180));
  return point.latitude >= south - latPad && point.latitude <= north + latPad
    && point.longitude >= west - lonPad && point.longitude <= east + lonPad;
}

function validateControls(points, bbox, options = {}) {
  const normalized = (points || []).map(normalizePoint).filter(Boolean);
  if (normalized.length < 3) return { accepted: false, reason: "insufficient-control-points", points: normalized };
  const uniquePixels = new Set(normalized.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`));
  if (uniquePixels.size < 3) return { accepted: false, reason: "duplicate-control-pixels", points: normalized };
  const paddingM = Number(options.geofencePaddingM ?? 1000);
  const inside = normalized.filter((point) => expandedBboxContains(point, bbox, paddingM));
  if (bbox && inside.length < Math.min(3, normalized.length)) {
    return { accepted: false, reason: "control-points-outside-park-geofence", points: normalized };
  }
  return { accepted: true, points: normalized };
}

function controlCandidate({ method, page, render, points, confidence = 0.99, quality = null }) {
  return {
    status: "accepted",
    method,
    directAuthority: true,
    page,
    pageWidth: Number(render?.width || 0),
    pageHeight: Number(render?.height || 0),
    crs: "EPSG:4326",
    points,
    confidence,
    candidateLocation: candidateCenter(points),
    quality: quality || { source: method }
  };
}

function explicitControlPoints(document, page) {
  const candidates = [
    document?.explicitControlPoints,
    document?.controlPoints,
    document?.georeference?.points,
    document?.georeference?.controlPoints,
    document?.metadata?.controlPoints
  ];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    const filtered = value.filter((point) => Number(point?.page ?? page) === Number(page));
    if (filtered.length >= 3) return filtered;
    if (value.length >= 3 && value.every((point) => point?.page == null)) return value;
  }
  return null;
}

function embeddedExtentControls(info, render) {
  const ring = info?.wgs84Extent?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const corners = ring.slice(0, 4).map((coordinate) => ({ longitude: finite(coordinate?.[0]), latitude: finite(coordinate?.[1]) }));
  if (corners.some((point) => point.longitude === null || point.latitude === null)) return null;
  const width = Number(render?.width || info?.size?.[0] || 0);
  const height = Number(render?.height || info?.size?.[1] || 0);
  if (!(width > 0 && height > 0)) return null;
  // GDAL's WGS84 footprint ring follows the raster perimeter UL -> LL -> LR -> UR.
  const pixels = [[0, 0], [0, height], [width, height], [width, 0]];
  return corners.map((point, index) => ({ x: pixels[index][0], y: pixels[index][1], ...point }));
}

function parseCoordinatePair(text) {
  const value = String(text || "").replace(/,/g, " ");
  const labelled = value.match(/(?:e(?:asting)?\s*[:=]?\s*)(\d{5,6}(?:\.\d+)?)\D{0,20}(?:n(?:orthing)?\s*[:=]?\s*)(\d{5,7}(?:\.\d+)?)/i);
  if (labelled) return { type: "osgb", first: Number(labelled[1]), second: Number(labelled[2]) };
  const numbers = [...value.matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter(Number.isFinite);
  for (let index = 0; index + 1 < numbers.length; index += 1) {
    const a = numbers[index], b = numbers[index + 1];
    if (a >= 10000 && a <= 700000 && b >= 10000 && b <= 1300000) return { type: "osgb", first: a, second: b };
    if (Math.abs(a) <= 180 && Math.abs(b) <= 90 && (String(a).includes(".") || String(b).includes("."))) {
      return { type: "wgs84", longitude: a, latitude: b };
    }
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && (String(a).includes(".") || String(b).includes("."))) {
      return { type: "wgs84", longitude: b, latitude: a };
    }
  }
  return null;
}

async function transformOsgbPairs(pairs, runTool, options = {}) {
  if (!pairs.length) return [];
  const input = pairs.map((pair) => `${pair.first} ${pair.second}`).join("\n") + "\n";
  const { stdout } = await runTool(options.gdaltransform || "gdaltransform", ["-s_srs", "EPSG:27700", "-t_srs", "EPSG:4326"], {
    input,
    timeoutMs: Number(options.toolTimeoutMs || 10000),
    maxStdoutBytes: 1024 * 1024
  });
  const lines = stdout.trim().split(/\r?\n/);
  return lines.map((line) => {
    const values = line.trim().split(/\s+/).map(Number);
    return values.length >= 2 && values.slice(0, 2).every(Number.isFinite)
      ? { longitude: values[0], latitude: values[1] }
      : null;
  });
}

export async function printedCoordinateControls(semantics, bbox, runTool, options = {}) {
  const records = [];
  for (const line of semantics?.lines || []) {
    const parsed = parseCoordinatePair(line.text);
    if (!parsed) continue;
    records.push({ parsed, bounds: line.bounds, confidence: Number(line.confidence || 0) });
  }
  if (records.length < 3) return null;
  const osgb = records.filter((record) => record.parsed.type === "osgb");
  let transformed = [];
  if (osgb.length) transformed = await transformOsgbPairs(osgb.map((record) => record.parsed), runTool, options);
  let osgbIndex = 0;
  const points = records.map((record) => {
    const bounds = record.bounds || {};
    let position = record.parsed;
    if (record.parsed.type === "osgb") position = transformed[osgbIndex++] || null;
    if (!position) return null;
    return {
      x: Number(bounds.centerX ?? (Number(bounds.left || 0) + Number(bounds.width || 0) / 2)),
      y: Number(bounds.centerY ?? (Number(bounds.top || 0) + Number(bounds.height || 0) / 2)),
      longitude: Number(position.longitude),
      latitude: Number(position.latitude)
    };
  }).filter(Boolean);
  const validation = validateControls(points, bbox, options);
  return validation.accepted ? validation.points : null;
}

export async function inspectEmbeddedGeospatial(document, options = {}) {
  const runTool = options.runTool;
  if (typeof runTool !== "function") throw new Error("embedded geospatial inspection requires runTool");
  if (String(document?.mime || "").toLowerCase() !== "application/pdf" && !String(document?.path || "").toLowerCase().endsWith(".pdf")) return null;
  try {
    const { stdout } = await runTool(options.gdalinfo || "gdalinfo", ["-json", document.path], {
      timeoutMs: Number(options.toolTimeoutMs || 10000),
      maxStdoutBytes: 4 * 1024 * 1024
    });
    const info = JSON.parse(stdout);
    return info?.wgs84Extent?.coordinates?.[0]?.length >= 4 ? info : null;
  } catch (error) {
    if (options.failOnEmbeddedInspectionError) throw error;
    return null;
  }
}

export async function resolveStrongGeoreference({ document, page, render, semantics, bbox }, options = {}) {
  const runTool = options.runTool;
  if (typeof runTool !== "function") throw new Error("strong georeference resolver requires runTool");

  if (Number(page) === 1) {
    const info = options.embeddedInfoProvided
      ? options.embeddedInfo
      : await inspectEmbeddedGeospatial(document, { ...options, runTool });
    const controls = embeddedExtentControls(info, render);
    if (controls) {
      const validation = validateControls(controls, bbox, options);
      if (validation.accepted) return controlCandidate({ method: "embedded-geospatial", page, render, points: validation.points, confidence: 1, quality: { source: "gdal-wgs84-extent" } });
    }
  }

  const explicit = explicitControlPoints(document, page);
  if (explicit) {
    const validation = validateControls(explicit, bbox, options);
    if (validation.accepted) return controlCandidate({ method: "explicit-control-points", page, render, points: validation.points, confidence: 1 });
  }

  const printed = await printedCoordinateControls(semantics, bbox, runTool, options);
  if (printed) return controlCandidate({ method: "printed-coordinate-controls", page, render, points: printed, confidence: 0.98 });
  return null;
}

export { validateControls, parseCoordinatePair, explicitControlPoints, embeddedExtentControls };
