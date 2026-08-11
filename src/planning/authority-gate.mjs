const EARTH_RADIUS_M = 6371008.8;

export const DEFAULT_PLANNING_AUTHORITY_GATE = Object.freeze({
  minConfidence: 0.86,
  minOverlap: 0.18,
  maxOffsetM: 25
});

function finite(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeBbox(bbox) {
  const values = Array.isArray(bbox)
    ? bbox
    : bbox && typeof bbox === "object"
      ? [bbox.south, bbox.west, bbox.north, bbox.east]
      : null;
  if (!values || values.length !== 4) return null;
  const [south, west, north, east] = values.map(finite);
  if ([south, west, north, east].some((value) => value === null) || !(south < north && west < east)) return null;
  return { south, west, north, east };
}

function solve3(matrix, vector) {
  const a = matrix.map((row, index) => [...row.map(Number), Number(vector[index])]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-12) return null;
    if (pivot !== column) [a[pivot], a[column]] = [a[column], a[pivot]];
    const divisor = a[column][column];
    for (let item = column; item < 4; item += 1) a[column][item] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = a[row][column];
      for (let item = column; item < 4; item += 1) a[row][item] -= factor * a[column][item];
    }
  }
  return a.map((row) => row[3]);
}

function fitAffine(points) {
  const usable = (points || []).map((point) => ({
    x: finite(point?.x),
    y: finite(point?.y),
    longitude: finite(point?.longitude ?? point?.lon ?? point?.lng),
    latitude: finite(point?.latitude ?? point?.lat)
  })).filter((point) => Object.values(point).every((value) => value !== null));
  if (usable.length < 3) return null;

  const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const lonVector = [0, 0, 0];
  const latVector = [0, 0, 0];
  for (const point of usable) {
    const row = [point.x, point.y, 1];
    for (let i = 0; i < 3; i += 1) {
      lonVector[i] += row[i] * point.longitude;
      latVector[i] += row[i] * point.latitude;
      for (let j = 0; j < 3; j += 1) normal[i][j] += row[i] * row[j];
    }
  }
  const longitude = solve3(normal, lonVector);
  const latitude = solve3(normal, latVector);
  if (!longitude || !latitude) return null;
  return { longitude, latitude };
}

function transformPoint(transform, x, y) {
  const row = [x, y, 1];
  return {
    x: row.reduce((sum, value, index) => sum + value * transform.longitude[index], 0),
    y: row.reduce((sum, value, index) => sum + value * transform.latitude[index], 0)
  };
}

function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    total += a.x * b.y - b.x * a.y;
  }
  return Math.abs(total) / 2;
}

function clipPolygon(points, inside, intersection) {
  if (!points.length) return [];
  const output = [];
  let previous = points.at(-1);
  let previousInside = inside(previous);
  for (const current of points) {
    const currentInside = inside(current);
    if (currentInside !== previousInside) output.push(intersection(previous, current));
    if (currentInside) output.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return output;
}

function interpolateAtX(a, b, x) {
  const denominator = b.x - a.x;
  const t = Math.abs(denominator) < 1e-15 ? 0 : (x - a.x) / denominator;
  return { x, y: a.y + (b.y - a.y) * t };
}

function interpolateAtY(a, b, y) {
  const denominator = b.y - a.y;
  const t = Math.abs(denominator) < 1e-15 ? 0 : (y - a.y) / denominator;
  return { x: a.x + (b.x - a.x) * t, y };
}

function clipToBbox(points, bbox) {
  let output = points;
  output = clipPolygon(output, (point) => point.x >= bbox.west, (a, b) => interpolateAtX(a, b, bbox.west));
  output = clipPolygon(output, (point) => point.x <= bbox.east, (a, b) => interpolateAtX(a, b, bbox.east));
  output = clipPolygon(output, (point) => point.y >= bbox.south, (a, b) => interpolateAtY(a, b, bbox.south));
  output = clipPolygon(output, (point) => point.y <= bbox.north, (a, b) => interpolateAtY(a, b, bbox.north));
  return output;
}

export function planningGeofenceOverlap(candidate, bbox) {
  const bounds = normalizeBbox(bbox);
  const width = finite(candidate?.pageWidth ?? candidate?.sourceImageWidth);
  const height = finite(candidate?.pageHeight ?? candidate?.sourceImageHeight);
  if (!bounds || !(width > 0) || !(height > 0)) return null;
  const transform = fitAffine(candidate?.points);
  if (!transform) return null;
  const extent = [
    transformPoint(transform, 0, 0),
    transformPoint(transform, width, 0),
    transformPoint(transform, width, height),
    transformPoint(transform, 0, height)
  ];
  const extentArea = polygonArea(extent);
  if (!(extentArea > 0)) return null;
  const overlapArea = polygonArea(clipToBbox(extent, bounds));
  return Math.max(0, Math.min(1, overlapArea / extentArea));
}

function haversineM(a, b) {
  const lat1 = finite(a?.latitude ?? a?.lat);
  const lon1 = finite(a?.longitude ?? a?.lon ?? a?.lng);
  const lat2 = finite(b?.latitude ?? b?.lat);
  const lon2 = finite(b?.longitude ?? b?.lon ?? b?.lng);
  if ([lat1, lon1, lat2, lon2].some((value) => value === null)) return null;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const p1 = lat1 * toRad;
  const p2 = lat2 * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function evaluatePlanningAuthority(candidate, context = {}) {
  const thresholds = {
    minConfidence: Number(context.minConfidence ?? DEFAULT_PLANNING_AUTHORITY_GATE.minConfidence),
    minOverlap: Number(context.minOverlap ?? DEFAULT_PLANNING_AUTHORITY_GATE.minOverlap),
    maxOffsetM: Number(context.maxOffsetM ?? DEFAULT_PLANNING_AUTHORITY_GATE.maxOffsetM)
  };
  const confidence = finite(candidate?.confidence) ?? 0;
  const overlap = planningGeofenceOverlap(candidate, context.bbox);
  const directAuthority = Boolean(candidate?.directAuthority);
  const reportedOffset = finite(candidate?.quality?.locationOffsetM ?? candidate?.locationOffsetM);
  const derivedOffset = reportedOffset ?? haversineM(candidate?.candidateLocation, context.locationPrior);
  const reasons = [];

  if (confidence < thresholds.minConfidence) reasons.push("confidence-below-authority-gate");
  if (overlap === null) reasons.push("build-geofence-overlap-unavailable");
  else if (overlap < thresholds.minOverlap) reasons.push("build-geofence-overlap-below-authority-gate");

  // Embedded/explicit/printed coordinates have already passed the strong georeference geofence/control validation.
  // The 25 m location-prior offset is therefore enforced on heuristic visual registration, not on direct geospatial controls.
  if (!directAuthority) {
    if (derivedOffset === null) reasons.push("registration-offset-unavailable");
    else if (derivedOffset > thresholds.maxOffsetM) reasons.push("registration-offset-above-authority-gate");
  }

  return {
    accepted: reasons.length === 0,
    mode: directAuthority ? "strong-georeference" : "visual-registration",
    confidence,
    overlap,
    offsetM: derivedOffset,
    thresholds,
    reasons
  };
}

export { fitAffine, polygonArea, normalizeBbox };
