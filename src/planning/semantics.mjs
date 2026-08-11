import { createHash } from "node:crypto";

const CLASSIFIERS = [
  ["ride-support-candidate", /\b(?:ride\s+support|track\s+support|support\s+(?:column|post|pier|footing)|column\s+base|support\s+base)\b/i],
  ["ride-layout-candidate", /\b(?:ride|roller\s*coaster|coaster|track)\s+(?:layout|alignment|centreline|centerline)|\b(?:track|ride)\s+layout\b/i],
  ["site-path-centerline-candidate", /\b(?:footbri(?:dge|dde)|footpath|footway|path|walkway|boardwalk|raised\s+walkway|raised\s+path|elevated\s+walkway|elevated\s+path|pedestrian\s+route|deck)\b/i],
  ["site-road-centerline-candidate", /\b(?:access\s+road|service\s+road|road|vehicle\s+route|carriageway)\b/i],
  ["building-footprint-candidate", /\b(?:building|station\s+building|shop|restaurant|toilet|plant\s+room|control\s+room|substation)\b/i],
  ["fence-candidate", /\b(?:fence|fencing|railing|railings|balustrade)\b/i],
  ["wall-candidate", /\b(?:retaining\s+wall|boundary\s+wall|wall)\b/i],
  ["barrier-candidate", /\b(?:barrier|guardrail|guard\s+rail|bollards?)\b/i],
  ["water-candidate", /\b(?:pond|lake|watercourse|stream|ditch|water\s+feature|basin)\b/i],
  ["rock-candidate", /\b(?:rock|rocks|boulder|boulders|rockwork)\b/i],
  ["terrain-detail-candidate", /\b(?:embankment|cutting|earthwork|mound|bank|slope|landform)\b/i]
];

export function classifyPlanningSemanticLabel(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  for (const [role, pattern] of CLASSIFIERS) if (pattern.test(value)) return role;
  return null;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function unionBounds(words) {
  const left = Math.min(...words.map((word) => word.left));
  const top = Math.min(...words.map((word) => word.top));
  const right = Math.max(...words.map((word) => word.left + word.width));
  const bottom = Math.max(...words.map((word) => word.top + word.height));
  return { left, top, width: right - left, height: bottom - top, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}

export function extractSemanticAnchorsFromTsv(tsv, options = {}) {
  const minConfidence = number(options.minConfidence, 35);
  const lines = String(tsv || "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { anchors: [], text: "", sha256: createHash("sha256").update(String(tsv || "")).digest("hex") };
  const header = lines[0].split("\t");
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  for (const required of ["page_num", "block_num", "par_num", "line_num", "left", "top", "width", "height", "conf", "text"]) {
    if (!(required in index)) throw new Error(`tesseract TSV missing ${required}`);
  }
  const groups = new Map();
  for (const line of lines.slice(1)) {
    const values = line.split("\t");
    const text = String(values[index.text] || "").trim();
    const confidence = number(values[index.conf], -1);
    if (!text || confidence < minConfidence) continue;
    const word = {
      text,
      confidence,
      left: number(values[index.left]),
      top: number(values[index.top]),
      width: number(values[index.width]),
      height: number(values[index.height])
    };
    const key = [values[index.page_num], values[index.block_num], values[index.par_num], values[index.line_num]].join(":");
    const group = groups.get(key) || [];
    group.push(word);
    groups.set(key, group);
  }

  const anchors = [];
  const allText = [];
  for (const [lineId, words] of groups) {
    const text = words.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim();
    allText.push(text);
    const role = classifyPlanningSemanticLabel(text);
    if (!role) continue;
    anchors.push({
      lineId,
      role,
      text,
      confidence: words.reduce((total, word) => total + word.confidence, 0) / words.length / 100,
      bounds: unionBounds(words)
    });
  }
  const normalizedText = allText.join("\n");
  return {
    anchors,
    text: normalizedText,
    sha256: createHash("sha256").update(normalizedText).digest("hex")
  };
}

function candidateBounds(candidate) {
  return candidate?.pageBounds || candidate?.properties?.pageBounds || null;
}

function center(bounds) {
  if (!bounds) return null;
  const left = number(bounds.left ?? bounds.x);
  const top = number(bounds.top ?? bounds.y);
  const width = number(bounds.width);
  const height = number(bounds.height);
  return { x: left + width / 2, y: top + height / 2 };
}

export function attachSemanticRoles(candidates, anchors, options = {}) {
  const maxDistancePx = number(options.maxDistancePx, 120);
  return (candidates || []).map((candidate) => {
    if (candidate?.role) return candidate;
    const origin = center(candidateBounds(candidate));
    if (!origin) return candidate;
    const nearest = (anchors || [])
      .map((anchor) => {
        const point = { x: anchor.bounds?.centerX, y: anchor.bounds?.centerY };
        const distancePx = Math.hypot(number(point.x) - origin.x, number(point.y) - origin.y);
        return { anchor, distancePx };
      })
      .filter((match) => match.anchor?.role && match.distancePx <= maxDistancePx)
      .sort((a, b) => a.distancePx - b.distancePx || Number(b.anchor.confidence || 0) - Number(a.anchor.confidence || 0))[0];
    if (!nearest) return candidate;
    return {
      ...candidate,
      role: nearest.anchor.role,
      confidence: Math.max(number(candidate.confidence), number(nearest.anchor.confidence)),
      properties: {
        ...(candidate.properties || {}),
        planning_semantic: true,
        planning_semantic_label: nearest.anchor.text,
        planning_semantic_distance_px: Math.round(nearest.distancePx * 10) / 10
      }
    };
  });
}
