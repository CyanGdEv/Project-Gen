import { createHash } from "node:crypto";
import path from "node:path";
import { classifyPlanningSemanticLabel } from "./semantics.mjs";

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function attributes(value) {
  const output = {};
  for (const match of String(value || "").matchAll(/([A-Za-z][\w:-]*)\s*=\s*"([^"]*)"/g)) output[match[1]] = match[2];
  return output;
}

function wordRecord(attributeText, body, scaleX, scaleY) {
  const attrs = attributes(attributeText);
  const text = decodeXml(body);
  const xMin = number(attrs.xMin);
  const yMin = number(attrs.yMin);
  const xMax = number(attrs.xMax);
  const yMax = number(attrs.yMax);
  if (!text || [xMin, yMin, xMax, yMax].some((value) => value === null) || xMax <= xMin || yMax <= yMin) return null;
  return {
    text,
    confidence: 1,
    left: xMin * scaleX,
    top: yMin * scaleY,
    width: (xMax - xMin) * scaleX,
    height: (yMax - yMin) * scaleY
  };
}

function unionBounds(words) {
  const left = Math.min(...words.map((word) => word.left));
  const top = Math.min(...words.map((word) => word.top));
  const right = Math.max(...words.map((word) => word.left + word.width));
  const bottom = Math.max(...words.map((word) => word.top + word.height));
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2
  };
}

export function extractSemanticAnchorsFromPdfBbox(xhtml, render = {}) {
  const source = String(xhtml || "");
  const pageMatch = source.match(/<page\b([^>]*)>([\s\S]*?)<\/page>/i);
  if (!pageMatch) return { anchors: [], lines: [], text: "", wordCount: 0, sha256: createHash("sha256").update("").digest("hex") };
  const pageAttrs = attributes(pageMatch[1]);
  const pageWidth = number(pageAttrs.width);
  const pageHeight = number(pageAttrs.height);
  if (!(pageWidth > 0) || !(pageHeight > 0) || !(Number(render.width) > 0) || !(Number(render.height) > 0)) {
    return { anchors: [], lines: [], text: "", wordCount: 0, sha256: createHash("sha256").update("").digest("hex") };
  }
  const scaleX = Number(render.width) / pageWidth;
  const scaleY = Number(render.height) / pageHeight;
  const lineRecords = [];
  const anchors = [];
  const allText = [];
  let wordCount = 0;

  const lineMatches = [...pageMatch[2].matchAll(/<line\b[^>]*>([\s\S]*?)<\/line>/gi)];
  const lineBodies = lineMatches.length ? lineMatches.map((match) => match[1]) : [pageMatch[2]];
  for (let lineIndex = 0; lineIndex < lineBodies.length; lineIndex += 1) {
    const words = [];
    for (const match of lineBodies[lineIndex].matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/gi)) {
      const word = wordRecord(match[1], match[2], scaleX, scaleY);
      if (word) words.push(word);
    }
    if (!words.length) continue;
    wordCount += words.length;
    const text = words.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const lineId = `pdf:1:${lineIndex + 1}`;
    const bounds = unionBounds(words);
    const line = { lineId, text, confidence: 1, bounds };
    lineRecords.push(line);
    allText.push(text);
    const role = classifyPlanningSemanticLabel(text);
    if (role) anchors.push({ ...line, role });
  }

  const normalizedText = allText.join("\n");
  return {
    anchors,
    lines: lineRecords,
    text: normalizedText,
    wordCount,
    pageSizePoints: { width: pageWidth, height: pageHeight },
    sha256: createHash("sha256").update(normalizedText).digest("hex")
  };
}

export function createPdfTextSemanticExtractor(options = {}) {
  if (typeof options.runTool !== "function") throw new Error("PDF text semantic extractor requires runTool");
  const pdftotext = options.pdftotext || "pdftotext";
  const timeoutMs = Math.max(500, Number(options.timeoutMs || 6000));
  const minCharacters = Math.max(1, Number(options.minCharacters || 24));
  const maxStdoutBytes = Math.max(1024 * 1024, Number(options.maxStdoutBytes || 12 * 1024 * 1024));

  return async function extractPdfTextSemantics(args, fallback) {
    const document = args?.document || {};
    const page = Math.max(1, Number(args?.page || 1));
    const render = args?.render || {};
    const source = path.resolve(document.path || document.file || "");
    const isPdf = String(document.mime || "").toLowerCase() === "application/pdf" || source.toLowerCase().endsWith(".pdf");
    if (!isPdf || !source) return fallback();

    try {
      const { stdout } = await options.runTool(pdftotext, [
        "-f", String(page),
        "-l", String(page),
        "-bbox-layout",
        source,
        "-"
      ], { timeoutMs, maxStdoutBytes });
      const parsed = extractSemanticAnchorsFromPdfBbox(stdout, render);
      if (parsed.text.replace(/\s+/g, "").length >= minCharacters && parsed.wordCount > 0) {
        return {
          ...parsed,
          engine: "pdftotext-bbox-v1",
          embeddedText: true,
          bboxSha256: createHash("sha256").update(stdout).digest("hex")
        };
      }
    } catch (error) {
      if (options.failOnPdfTextError) throw error;
    }
    return fallback();
  };
}
