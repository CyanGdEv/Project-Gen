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

function semanticResult(lineGroups, rawForEmptyHash = "") {
  const anchors = [];
  const lineRecords = [];
  const allText = [];
  for (const [lineId, words] of lineGroups) {
    if (!words.length) continue;
    const text = words.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const confidence = words.reduce((total, word) => total + number(word.confidence, 1), 0) / words.length;
    const bounds = unionBounds(words);
    allText.push(text);
    lineRecords.push({ lineId, text, confidence, bounds });
    const role = classifyPlanningSemanticLabel(text);
    if (role) anchors.push({ lineId, role, text, confidence, bounds });
  }
  const normalizedText = allText.join("\n");
  return {
    anchors,
    lines: lineRecords,
    text: normalizedText,
    sha256: createHash("sha256").update(normalizedText || String(rawForEmptyHash || "")).digest("hex")
  };
}

export function extractSemanticAnchorsFromTsv(tsv, options = {}) {
  const minConfidence = number(options.minConfidence, 35);
  const scaleX = Math.max(0.000001, number(options.coordinateScaleX, 1));
  const scaleY = Math.max(0.000001, number(options.coordinateScaleY, 1));
  const lines = String(tsv || "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { anchors: [], lines: [], text: "", sha256: createHash("sha256").update(String(tsv || "")).digest("hex") };
  const header = lines[0].split("\t");
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  for (const required of ["page_num", "block_num", "par_num", "line_num", "left", "top", "width", "height", "conf", "text"]) {
    if (!(required in index)) throw new Error(`tesseract TSV missing ${required}`);
  }
  const groups = new Map();
  for (const line of lines.slice(1)) {
    const values = line.split("\t");
    const text = String(values[index.text] || "").trim();
    const rawConfidence = number(values[index.conf], -1);
    if (!text || rawConfidence < minConfidence) continue;
    const word = {
      text,
      confidence: rawConfidence / 100,
      left: number(values[index.left]) * scaleX,
      top: number(values[index.top]) * scaleY,
      width: number(values[index.width]) * scaleX,
      height: number(values[index.height]) * scaleY
    };
    const key = [values[index.page_num], values[index.block_num], values[index.par_num], values[index.line_num]].join(":");
    const group = groups.get(key) || [];
    group.push(word);
    groups.set(key, group);
  }
  return semanticResult(groups, tsv);
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function attributes(source) {
  const result = {};
  for (const match of String(source || "").matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) result[match[1]] = match[2];
  return result;
}

export function extractSemanticAnchorsFromPopplerBbox(xhtml, render, options = {}) {
  const source = String(xhtml || "");
  const pageMatch = source.match(/<page\b([^>]*)>/i);
  if (!pageMatch) return { anchors: [], lines: [], text: "", sha256: createHash("sha256").update(source).digest("hex"), wordCount: 0 };
  const pageAttrs = attributes(pageMatch[1]);
  const pageWidth = number(pageAttrs.width, 0);
  const pageHeight = number(pageAttrs.height, 0);
  if (!(pageWidth > 0 && pageHeight > 0 && Number(render?.width) > 0 && Number(render?.height) > 0)) {
    return { anchors: [], lines: [], text: "", sha256: createHash("sha256").update(source).digest("hex"), wordCount: 0 };
  }
  const scaleX = Number(render.width) / pageWidth;
  const scaleY = Number(render.height) / pageHeight;
  const groups = new Map();
  let lineIndex = 0;
  let wordCount = 0;
  for (const lineMatch of source.matchAll(/<line\b[^>]*>([\s\S]*?)<\/line>/gi)) {
    const words = [];
    for (const wordMatch of lineMatch[1].matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/gi)) {
      const attrs = attributes(wordMatch[1]);
      const text = decodeXml(wordMatch[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
      const xMin = number(attrs.xMin, NaN), yMin = number(attrs.yMin, NaN), xMax = number(attrs.xMax, NaN), yMax = number(attrs.yMax, NaN);
      if (!text || ![xMin, yMin, xMax, yMax].every(Number.isFinite) || xMax < xMin || yMax < yMin) continue;
      wordCount += 1;
      words.push({
        text,
        confidence: 1,
        left: xMin * scaleX,
        top: yMin * scaleY,
        width: (xMax - xMin) * scaleX,
        height: (yMax - yMin) * scaleY
      });
    }
    if (words.length) groups.set(`pdf:${lineIndex++}`, words);
  }
  const result = semanticResult(groups, source);
  return { ...result, wordCount, pageWidth, pageHeight, coordinateScaleX: scaleX, coordinateScaleY: scaleY };
}

export function semanticTextIsUseful(semantics, options = {}) {
  const minWords = Math.max(1, number(options.minWords, 5));
  const minChars = Math.max(1, number(options.minChars, 32));
  const text = String(semantics?.text || "").trim();
  const words = number(semantics?.wordCount, text ? text.split(/\s+/).filter(Boolean).length : 0);
  return words >= minWords && text.length >= minChars;
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
