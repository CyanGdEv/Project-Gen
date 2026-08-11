import {
  normalizePlanningApplicationStatus,
  planningApplicationAuthorityReason,
  planningApplicationWorldAuthorityEligible
} from "./authority-status.mjs";

const EARTH_RADIUS_M = 6371008.8;

export const DEFAULT_FEATURE_AUTHORITY_CONFIG = Object.freeze({
  minConfidence: 0.86,
  minOverlap: 0.18,
  maxOffsetM: 25,
  toleranceM: 3,
  allowGapFill: true
});

function finite(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
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

function localProjector(bbox) {
  const bounds = normalizeBbox(bbox);
  if (!bounds) throw new Error("feature authority requires a valid bbox");
  const latitude = (bounds.south + bounds.north) / 2;
  const longitude = (bounds.west + bounds.east) / 2;
  const latRad = latitude * Math.PI / 180;
  const xScale = Math.cos(latRad) * EARTH_RADIUS_M * Math.PI / 180;
  const zScale = EARTH_RADIUS_M * Math.PI / 180;
  return ([lon, lat]) => [(Number(lon) - longitude) * xScale, (Number(lat) - latitude) * zScale];
}

function mapCoordinates(value, projector) {
  if (!Array.isArray(value)) return value;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) return projector(value);
  return value.map((item) => mapCoordinates(item, projector));
}

export function projectWgs84Geometry(geometry, bbox) {
  if (!geometry?.type || !geometry.coordinates) return null;
  return { type: geometry.type, coordinates: mapCoordinates(geometry.coordinates, localProjector(bbox)) };
}

function closedRing(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 4) return false;
  const first = coordinates[0];
  const last = coordinates.at(-1);
  return Array.isArray(first) && Array.isArray(last)
    && Number(first[0]) === Number(last[0])
    && Number(first[1]) === Number(last[1]);
}

function osmKind(tags = {}) {
  if (tags.building) return "building";
  if (tags.highway) return "path";
  if (tags.barrier === "wall") return "wall";
  if (tags.barrier === "fence") return "fence";
  if (tags.barrier) return "barrier";
  if (tags.water || tags.waterway || tags.natural === "water") return "water";
  if (["bare_rock", "rock", "scree"].includes(String(tags.natural || ""))) return "rock";
  if (tags.roller_coaster || tags.attraction === "roller_coaster" || tags.railway === "roller_coaster") return "ride-layout";
  return null;
}

function geometryForOsmElement(element, kind) {
  const coordinates = Array.isArray(element?.geometry)
    ? element.geometry
        .map((point) => [finite(point?.lon), finite(point?.lat)])
        .filter(([lon, lat]) => lon !== null && lat !== null)
    : [];
  if (coordinates.length >= 2) {
    const areaKind = ["building", "water", "rock"].includes(kind);
    if (areaKind && closedRing(coordinates)) return { type: "Polygon", coordinates: [coordinates] };
    return { type: "LineString", coordinates };
  }
  const lon = finite(element?.lon);
  const lat = finite(element?.lat);
  if (lon !== null && lat !== null) return { type: "Point", coordinates: [lon, lat] };
  return null;
}

export function normalizeOsmReferenceFeatures(payload, bbox) {
  const output = [];
  for (const element of payload?.elements || []) {
    const tags = element?.tags || {};
    const kind = osmKind(tags);
    if (!kind) continue;
    const geometry = geometryForOsmElement(element, kind);
    if (!geometry) continue;
    const localGeometry = projectWgs84Geometry(geometry, bbox);
    if (!localGeometry) continue;
    output.push({
      id: `osm:${element.type || "element"}:${element.id}`,
      kind,
      name: tags.name || tags.ref || null,
      geometry,
      localGeometry,
      source: {
        provider: "OpenStreetMap",
        elementType: element.type || null,
        elementId: element.id ?? null,
        role: "planning-validation-reference-only-never-rendered"
      }
    });
  }
  return output;
}

function normalizedName(value) {
  return value ? String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() : "";
}

function geometryBounds(geometry) {
  const points = [];
  function walk(value) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      points.push([Number(value[0]), Number(value[1])]);
      return;
    }
    for (const item of value) walk(item);
  }
  walk(geometry?.coordinates);
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map((point) => point[0])),
    minZ: Math.min(...points.map((point) => point[1])),
    maxX: Math.max(...points.map((point) => point[0])),
    maxZ: Math.max(...points.map((point) => point[1]))
  };
}

function boundsCenterDistance(first, second) {
  const a = geometryBounds(first);
  const b = geometryBounds(second);
  if (!a || !b) return Infinity;
  return Math.hypot((a.minX + a.maxX - b.minX - b.maxX) / 2, (a.minZ + a.maxZ - b.minZ - b.maxZ) / 2);
}

function polygonArea(ring = []) {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    area += Number(a?.[0] || 0) * Number(b?.[1] || 0) - Number(b?.[0] || 0) * Number(a?.[1] || 0);
  }
  return Math.abs(area) / 2;
}

function polygonNetArea(rings) {
  if (!rings?.length) return 0;
  return Math.max(0, polygonArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + polygonArea(ring), 0));
}

function localGeometryArea(geometry) {
  if (geometry?.type === "Polygon") return polygonNetArea(geometry.coordinates);
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.reduce((sum, polygon) => sum + polygonNetArea(polygon), 0);
  return 0;
}

function pointInRing(x, z, ring = []) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i]?.[0]);
    const zi = Number(ring[i]?.[1]);
    const xj = Number(ring[j]?.[0]);
    const zj = Number(ring[j]?.[1]);
    const crosses = ((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / ((zj - zi) || Number.EPSILON) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, z, rings = []) {
  if (!rings.length || !pointInRing(x, z, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(x, z, ring));
}

function pointInsideAreaGeometry(geometry, x, z) {
  if (geometry?.type === "Polygon") return pointInPolygon(x, z, geometry.coordinates);
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.some((polygon) => pointInPolygon(x, z, polygon));
  return false;
}

function isAreaGeometry(geometry) {
  return ["Polygon", "MultiPolygon"].includes(geometry?.type);
}

function isLineGeometry(geometry) {
  return ["LineString", "MultiLineString"].includes(geometry?.type);
}

export function approximateAreaOverlap(first, second) {
  const aBounds = geometryBounds(first);
  const bBounds = geometryBounds(second);
  const areaA = localGeometryArea(first);
  const areaB = localGeometryArea(second);
  if (!aBounds || !bBounds || !areaA || !areaB) {
    return { intersectionArea: 0, planningArea: areaA, osmArea: areaB, planningFraction: 0, osmFraction: 0, iou: 0 };
  }
  const intersection = {
    minX: Math.max(aBounds.minX, bBounds.minX),
    minZ: Math.max(aBounds.minZ, bBounds.minZ),
    maxX: Math.min(aBounds.maxX, bBounds.maxX),
    maxZ: Math.min(aBounds.maxZ, bBounds.maxZ)
  };
  if (intersection.minX >= intersection.maxX || intersection.minZ >= intersection.maxZ) {
    return { intersectionArea: 0, planningArea: areaA, osmArea: areaB, planningFraction: 0, osmFraction: 0, iou: 0 };
  }
  const boundsArea = (intersection.maxX - intersection.minX) * (intersection.maxZ - intersection.minZ);
  const spacing = Math.max(0.5, Math.min(3, Math.sqrt(boundsArea / 4000) || 0.5));
  let insideBoth = 0;
  let samples = 0;
  for (let z = intersection.minZ + spacing / 2; z < intersection.maxZ; z += spacing) {
    for (let x = intersection.minX + spacing / 2; x < intersection.maxX; x += spacing) {
      samples += 1;
      if (pointInsideAreaGeometry(first, x, z) && pointInsideAreaGeometry(second, x, z)) insideBoth += 1;
    }
  }
  const intersectionArea = samples ? insideBoth * spacing * spacing : 0;
  const union = Math.max(Number.EPSILON, areaA + areaB - intersectionArea);
  return {
    intersectionArea,
    planningArea: areaA,
    osmArea: areaB,
    planningFraction: Math.min(1, intersectionArea / areaA),
    osmFraction: Math.min(1, intersectionArea / areaB),
    iou: Math.min(1, intersectionArea / union)
  };
}

function lineStrings(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates || []];
  if (geometry?.type === "MultiLineString") return geometry.coordinates || [];
  return [];
}

function segmentDistance(point, a, b) {
  const vx = b[0] - a[0];
  const vz = b[1] - a[1];
  const wx = point[0] - a[0];
  const wz = point[1] - a[1];
  const lengthSquared = vx * vx + vz * vz;
  const t = lengthSquared <= Number.EPSILON ? 0 : Math.max(0, Math.min(1, (wx * vx + wz * vz) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + vx * t), point[1] - (a[1] + vz * t));
}

function distanceToLines(point, geometry) {
  let best = Infinity;
  for (const line of lineStrings(geometry)) {
    for (let index = 1; index < line.length; index += 1) best = Math.min(best, segmentDistance(point, line[index - 1], line[index]));
  }
  return best;
}

export function lineOverlapPair(first, second, toleranceM) {
  const spacing = Math.max(0.75, Math.min(3, Number(toleranceM) / 4 || 1));
  let totalLength = 0;
  let matchedLength = 0;
  for (const line of lineStrings(first)) {
    for (let index = 1; index < line.length; index += 1) {
      const a = line[index - 1];
      const b = line[index];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!(length > 0)) continue;
      const samples = Math.max(1, Math.ceil(length / spacing));
      const sampleLength = length / samples;
      totalLength += length;
      for (let sample = 0; sample < samples; sample += 1) {
        const t = (sample + 0.5) / samples;
        const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (distanceToLines(point, second) <= toleranceM) matchedLength += sampleLength;
      }
    }
  }
  return totalLength ? Math.min(1, matchedLength / totalLength) : 0;
}

function planningKindsCompatible(first, second) {
  if (first === second) return true;
  return [first, second].every((kind) => ["path", "road"].includes(kind));
}

export function planningGeometryMatch(planning, reference, config = {}) {
  const policy = { ...DEFAULT_FEATURE_AUTHORITY_CONFIG, ...config };
  const first = planning?.localGeometry;
  const second = reference?.localGeometry;
  if (!first || !second) return { match: false, equivalent: false, score: 0 };
  const nameMatch = normalizedName(planning.name) && normalizedName(planning.name) === normalizedName(reference.name);
  if (isAreaGeometry(first) && isAreaGeometry(second)) {
    const overlap = approximateAreaOverlap(first, second);
    const distanceM = boundsCenterDistance(first, second);
    const overlapMatch = Math.max(overlap.planningFraction, overlap.osmFraction, overlap.iou) >= policy.minOverlap;
    const proximityMatch = nameMatch && distanceM <= policy.maxOffsetM;
    const score = Math.max(
      overlap.iou,
      Math.min(overlap.planningFraction, overlap.osmFraction),
      proximityMatch ? 0.5 * (1 - distanceM / Math.max(1, policy.maxOffsetM)) : 0
    );
    return {
      match: overlapMatch || proximityMatch,
      equivalent: overlap.planningFraction >= 0.82 && overlap.osmFraction >= 0.82,
      score,
      distanceM,
      nameMatch: Boolean(nameMatch),
      ...overlap
    };
  }
  if (isLineGeometry(first) && isLineGeometry(second)) {
    const looseForward = lineOverlapPair(first, second, policy.maxOffsetM);
    const looseReverse = lineOverlapPair(second, first, policy.maxOffsetM);
    const strictForward = lineOverlapPair(first, second, policy.toleranceM);
    const strictReverse = lineOverlapPair(second, first, policy.toleranceM);
    const distanceM = boundsCenterDistance(first, second);
    const score = Math.max(Math.min(looseForward, looseReverse), nameMatch && distanceM <= policy.maxOffsetM ? 0.45 : 0);
    return {
      match: Math.max(looseForward, looseReverse) >= policy.minOverlap || (nameMatch && distanceM <= policy.maxOffsetM),
      equivalent: strictForward >= 0.82 && strictReverse >= 0.82,
      score,
      distanceM,
      nameMatch: Boolean(nameMatch),
      planningFraction: looseForward,
      osmFraction: looseReverse,
      strictPlanningFraction: strictForward,
      strictOsmFraction: strictReverse
    };
  }
  if (first.type === "Point" && second.type === "Point") {
    const distanceM = Math.hypot(first.coordinates[0] - second.coordinates[0], first.coordinates[1] - second.coordinates[1]);
    return {
      match: distanceM <= policy.maxOffsetM && (nameMatch || distanceM <= Math.max(3, policy.toleranceM)),
      equivalent: distanceM <= policy.toleranceM,
      score: Math.max(0, 1 - distanceM / Math.max(1, policy.maxOffsetM)),
      distanceM,
      nameMatch: Boolean(nameMatch)
    };
  }
  return { match: false, equivalent: false, score: 0 };
}

function compactMetrics(metrics = {}) {
  return Object.fromEntries(Object.entries(metrics)
    .filter(([key, value]) => !["match", "equivalent"].includes(key) && (typeof value === "number" || typeof value === "boolean"))
    .map(([key, value]) => [key, typeof value === "number" ? Math.round(value * 1000) / 1000 : value]));
}

export function evaluatePlanningFeatureAuthority(feature, referenceFeatures = [], options = {}) {
  const config = { ...DEFAULT_FEATURE_AUTHORITY_CONFIG, ...options };
  const properties = feature?.properties || {};
  const applicationStatus = properties.planningApplicationStatus == null
    ? null
    : normalizePlanningApplicationStatus(properties.planningApplicationStatus);
  const statusEligible = properties.planningWorldAuthorityEligible === true
    || (applicationStatus === null && properties.planningWorldAuthorityEligible !== false)
    || planningApplicationWorldAuthorityEligible(applicationStatus);
  const confidence = clamp01(properties.confidence);
  const kind = properties.featureClass || null;
  const reasons = [];
  if (!statusEligible) reasons.push("application-status-not-world-authority-eligible");
  if (confidence < config.minConfidence) reasons.push("confidence-below-authority-gate");
  if (!kind || !feature?.geometry) reasons.push("planning-feature-geometry-unavailable");
  if (reasons.length) {
    return {
      accepted: false,
      action: "withheld",
      applicationStatus,
      applicationStatusReason: planningApplicationAuthorityReason(applicationStatus),
      confidence,
      matchedTargetId: null,
      alternateTargetId: null,
      metrics: null,
      reasons
    };
  }

  const localGeometry = projectWgs84Geometry(feature.geometry, options.bbox);
  const planning = { kind, name: properties.name || properties.ref || null, localGeometry };
  const matches = referenceFeatures
    .filter((candidate) => planningKindsCompatible(kind, candidate.kind))
    .map((candidate) => ({ candidate, metrics: planningGeometryMatch(planning, candidate, config) }))
    .filter((entry) => entry.metrics.match)
    .sort((a, b) => b.metrics.score - a.metrics.score || String(a.candidate.id).localeCompare(String(b.candidate.id)));

  if (!matches.length) {
    if (!config.allowGapFill) {
      return { accepted: false, action: "missing-reference-target", applicationStatus, confidence, matchedTargetId: null, alternateTargetId: null, metrics: null, reasons: ["compatible-reference-target-required"] };
    }
    return {
      accepted: true,
      action: "planning-authority-gap-fill",
      applicationStatus,
      confidence,
      matchedTargetId: null,
      alternateTargetId: null,
      metrics: null,
      reasons: []
    };
  }

  const best = matches[0];
  const second = matches[1];
  if (second && second.metrics.score >= Math.max(config.minOverlap, best.metrics.score * 0.9)) {
    return {
      accepted: false,
      action: "ambiguous-reference-withheld",
      applicationStatus,
      confidence,
      matchedTargetId: best.candidate.id,
      alternateTargetId: second.candidate.id,
      metrics: compactMetrics(best.metrics),
      reasons: ["ambiguous-compatible-reference-targets"]
    };
  }

  return {
    accepted: true,
    action: best.metrics.equivalent ? "planning-authority-corroborated" : "planning-authority-replaces-reference",
    applicationStatus,
    confidence,
    matchedTargetId: best.candidate.id,
    alternateTargetId: null,
    metrics: compactMetrics(best.metrics),
    reasons: []
  };
}

export function applyPlanningFeatureAuthority(features, referenceFeatures, options = {}) {
  const accepted = [];
  const evaluations = [];
  const rejectionReasons = {};
  const actions = {};
  for (const feature of features || []) {
    const evaluation = evaluatePlanningFeatureAuthority(feature, referenceFeatures, options);
    evaluations.push({ featureId: feature.id || null, featureClass: feature.properties?.featureClass || null, ...evaluation });
    actions[evaluation.action] = Number(actions[evaluation.action] || 0) + 1;
    if (!evaluation.accepted) {
      for (const reason of evaluation.reasons || []) rejectionReasons[reason] = Number(rejectionReasons[reason] || 0) + 1;
      continue;
    }
    accepted.push({
      ...feature,
      properties: {
        ...(feature.properties || {}),
        planningWorldAuthority: true,
        planningAuthorityAction: evaluation.action,
        planningValidationTargetId: evaluation.matchedTargetId,
        planningValidationMetrics: evaluation.metrics,
        osmWorldRenderable: false
      }
    });
  }
  return { accepted, evaluations, actions, rejectionReasons };
}
