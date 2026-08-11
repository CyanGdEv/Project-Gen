const DEFAULT_SOURCE_RANK = 0;

export const SOURCE_RANK = Object.freeze({
  planning: 1000,
  "licensed-orthophoto": 900,
  lidar: 850,
  "os-openmap-local": 700,
  "national-trees-outside-woodland": 650,
  "planning-data": 640,
  "microsoft-buildings": 500,
  wikidata: 300,
  wikimedia: 250,
  openaerialmap: 200,
  osm: 100
});

export const PLANNING_LOCKED_CLASSES = new Set([
  "ride-layout",
  "ride-support",
  "path",
  "path-material",
  "building",
  "wall",
  "barrier",
  "fence",
  "water",
  "rock",
  "terrain-detail"
]);

function sourceName(feature) {
  return String(feature?.properties?.source || "unknown").trim().toLowerCase();
}

function featureClass(feature) {
  return String(feature?.properties?.featureClass || feature?.properties?.class || "unknown")
    .trim()
    .toLowerCase();
}

function authorityKey(feature, index) {
  const explicit = feature?.properties?.authorityKey || feature?.properties?.authority_key;
  if (explicit) return String(explicit);
  const id = feature?.id ?? feature?.properties?.id ?? index;
  return `${featureClass(feature)}:${id}`;
}

function confidence(feature) {
  const value = Number(feature?.properties?.confidence ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function rank(feature) {
  return SOURCE_RANK[sourceName(feature)] ?? DEFAULT_SOURCE_RANK;
}

function stableWinner(a, b) {
  const rankDelta = rank(b.feature) - rank(a.feature);
  if (rankDelta) return rankDelta;
  const confidenceDelta = confidence(b.feature) - confidence(a.feature);
  if (confidenceDelta) return confidenceDelta;
  return a.index - b.index;
}

export function resolveEvidence(features) {
  if (!Array.isArray(features)) throw new TypeError("features must be an array");

  const groups = new Map();
  features.forEach((feature, index) => {
    if (!feature || feature.type !== "Feature") return;
    const key = authorityKey(feature, index);
    const list = groups.get(key) || [];
    list.push({ feature, index });
    groups.set(key, list);
  });

  const winners = [];
  const decisions = [];

  for (const [key, candidates] of groups) {
    const clazz = featureClass(candidates[0].feature);
    const planning = candidates.filter(({ feature }) => sourceName(feature) === "planning");
    const pool = PLANNING_LOCKED_CLASSES.has(clazz) && planning.length ? planning : candidates;
    const sorted = [...pool].sort(stableWinner);
    const winner = sorted[0];
    winners.push(winner.feature);
    decisions.push({
      authorityKey: key,
      featureClass: clazz,
      winnerSource: sourceName(winner.feature),
      planningLocked: PLANNING_LOCKED_CLASSES.has(clazz) && planning.length > 0,
      candidateCount: candidates.length
    });
  }

  return { winners, decisions };
}

export function assertPlanningAuthority(features, result = resolveEvidence(features)) {
  const candidateGroups = new Map();
  features.forEach((feature, index) => {
    if (!feature || feature.type !== "Feature") return;
    const key = authorityKey(feature, index);
    const list = candidateGroups.get(key) || [];
    list.push(feature);
    candidateGroups.set(key, list);
  });

  for (const decision of result.decisions) {
    if (!PLANNING_LOCKED_CLASSES.has(decision.featureClass)) continue;
    const group = candidateGroups.get(decision.authorityKey) || [];
    const hasPlanning = group.some((feature) => sourceName(feature) === "planning");
    if (hasPlanning && decision.winnerSource !== "planning") {
      throw new Error(`planning authority violated for ${decision.authorityKey}`);
    }
  }
  return true;
}
