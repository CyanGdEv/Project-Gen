import { classifyPlanningDocument } from "../sources/planning-prefetch.mjs";

const NARRATIVE_ATTACHMENT = /\b(?:design\s*(?:and|&)\s*access|landscape\s*(?:and|&)\s*visual\s+impact|lvia|statement|assessment|report|supporting\s+information|cover(?:ing)?\s+letter|application\s+form|decision|notice|certificate)\b/i;
const PROPOSED_DRAWING = /\b(?:proposed|new)\b/i;
const EXISTING_DRAWING = /\bexisting\b/i;
const RIDE_DRAWING = /\b(?:roller\s*coaster|coaster|ride|track)\b.*\b(?:plan|layout|general\s+arrangement|g\.?a\.?|drawing|site\s+plan)\b|\b(?:plan|layout|general\s+arrangement|g\.?a\.?|drawing|site\s+plan)\b.*\b(?:roller\s*coaster|coaster|ride|track)\b/i;
const DRAWING_CUE = /\b(?:site\s+plan|block\s+plan|general\s+arrangement|g\.?a\.?|layout|topographical|topographic|elevation|section|roof\s+plan|landscape\s+plan|drainage\s+plan|drawing)\b/i;

function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function hrefFromAttributes(value) {
  const match = String(value || "").match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  return match ? (match[1] || match[2] || match[3] || "") : "";
}

function imageNameFromUrl(value) {
  try {
    const url = new URL(value, "https://planning.invalid/");
    return url.searchParams.get("ImageName") || url.searchParams.get("imagename") || null;
  } catch {
    return null;
  }
}

function rowTextForOffset(html, offset) {
  const before = html.lastIndexOf("<tr", offset);
  const after = html.indexOf("</tr>", offset);
  if (before < 0 || after < 0) return "";
  return decodeHtml(html.slice(before, after + 5));
}

export function rankPlanningAttachment(metadata = {}) {
  const text = [metadata.title, metadata.rowText, metadata.documentType].filter(Boolean).join(" ").trim();
  const classification = classifyPlanningDocument({
    title: metadata.title,
    text: metadata.rowText,
    documentType: metadata.documentType
  });
  const narrative = NARRATIVE_ATTACHMENT.test(text) || classification.narrative;
  const proposed = PROPOSED_DRAWING.test(text) && !EXISTING_DRAWING.test(text);
  const existing = EXISTING_DRAWING.test(text);
  const rideLayout = RIDE_DRAWING.test(text) && !narrative;
  const drawing = DRAWING_CUE.test(text) && !narrative;

  let score = classification.priority;
  if (rideLayout) score = Math.max(score, 220);
  else if (proposed && drawing) score += 45;
  else if (drawing) score += 15;
  if (existing) score -= 55;
  if (narrative) score = Math.min(score, -150);

  return {
    classification: rideLayout ? "ride-layout" : classification.classification,
    priority: score,
    narrative,
    proposed,
    existing,
    rideLayout,
    drawing
  };
}

export function parsePlanningApplicationAttachments(html, options = {}) {
  const source = String(html || "");
  const applicationUrl = options.applicationUrl || "https://planning.invalid/portal/servlets/ApplicationSearchServlet";
  const seen = new Map();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(anchorPattern)) {
    const href = hrefFromAttributes(match[1]);
    if (!/AttachmentShowServlet/i.test(href)) continue;
    let resolved;
    try {
      resolved = new URL(href, applicationUrl);
    } catch {
      continue;
    }
    const imageName = imageNameFromUrl(resolved.toString());
    if (!imageName) continue;
    const title = decodeHtml(match[2]);
    const rowText = rowTextForOffset(source, match.index || 0);
    const ranking = rankPlanningAttachment({ title, rowText });
    const id = String(imageName);
    const current = seen.get(id);
    const candidate = {
      imageName: id,
      title: title || null,
      rowText: rowText || null,
      url: resolved.toString().replace(/^http:/i, "https:"),
      transportUrl: resolved.toString().replace(/^https:/i, "http:"),
      tlsVerification: "legacy-http-official-host",
      ...ranking
    };
    if (!current || candidate.priority > current.priority || (candidate.title && !current.title)) seen.set(id, candidate);
  }
  return [...seen.values()].sort((a, b) => b.priority - a.priority || Number(a.narrative) - Number(b.narrative) || a.imageName.localeCompare(b.imageName));
}

function safeApplicationUrls(applicationUrl, options = {}) {
  const primary = new URL(applicationUrl);
  if (primary.protocol !== "https:") throw new Error("planning application URL must use HTTPS");
  const values = [primary.toString()];
  if (options.allowLegacyHttpTransport) values.unshift(primary.toString().replace(/^https:/i, "http:"));
  return [...new Set(values)];
}

function retryable(error) {
  const name = String(error?.name || "");
  const code = String(error?.code || "").toUpperCase();
  return name === "AbortError" || name === "TimeoutError" || /fetch failed/i.test(String(error?.message || ""))
    || ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"].includes(code);
}

export async function discoverPlanningApplicationAttachments(applicationUrl, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("planning attachment discovery requires fetch()");
  const urls = safeApplicationUrls(applicationUrl, options);
  const retries = Math.min(4, Math.max(0, Number(options.retries ?? 2)));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000));
  const attempts = [];

  for (let round = 0; round <= retries; round += 1) {
    for (const candidate of urls) {
      try {
        const response = await fetchImpl(candidate, {
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "user-agent": options.userAgent || "Project-Gen/0.1 planning-attachment-discovery" }
        });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw error;
        }
        const html = await response.text();
        const attachments = parsePlanningApplicationAttachments(html, { applicationUrl: response.url || applicationUrl });
        return {
          status: "usable",
          applicationUrl,
          fetchedUrl: response.url || candidate,
          attachments,
          drawingAttachments: attachments.filter((item) => item.drawing),
          proposedDrawingAttachments: attachments.filter((item) => item.drawing && item.proposed),
          rideLayoutAttachments: attachments.filter((item) => item.rideLayout),
          attempts: attempts.length + 1
        };
      } catch (error) {
        attempts.push({ url: candidate, round, message: error?.message || String(error) });
        if (!error?.retryable && !retryable(error)) throw error;
      }
    }
  }
  throw new Error(`unable to discover planning attachments after ${attempts.length} attempts: ${attempts.at(-1)?.message || "unknown failure"}`);
}
