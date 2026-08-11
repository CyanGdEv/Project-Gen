import { classifyPlanningDocument } from "../sources/planning-prefetch.mjs";

const NARRATIVE_ATTACHMENT = /\b(?:design\s*(?:and|&)\s*access|landscape\s*(?:and|&)\s*visual\s+impact|lvia|statement|assessment|report|supporting\s+information|cover(?:ing)?\s+letter|application\s+form|decision|notice|certificate)\b/i;
const PROPOSED_DRAWING = /\b(?:proposed|new)\b/i;
const EXISTING_DRAWING = /\bexisting\b/i;
const RIDE_DRAWING = /\b(?:roller\s*coaster|coaster|ride|track)\b.*\b(?:plan|layout|general\s+arrangement|g\.?a\.?|drawing|site\s+plan)\b|\b(?:plan|layout|general\s+arrangement|g\.?a\.?|drawing|site\s+plan)\b.*\b(?:roller\s*coaster|coaster|ride|track)\b/i;
const DRAWING_CUE = /\b(?:site\s+plan|block\s+plan|general\s+arrangement|g\.?a\.?|layout|topographical|topographic|elevation|section|roof\s+plan|landscape\s+plan|drainage\s+plan|drawing)\b/i;
const DOCUMENT_NAV_TEXT = /\b(?:documents?|plans?|drawings?|associated\s+documents?|view\s+documents?|application\s+documents?)\b/i;
const DOCUMENT_NAV_HREF = /(?:document|drawing|plan|image|attachment)/i;

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

function decodeUrlMarkup(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\x26/gi, "&");
}

function hrefFromAttributes(value) {
  const match = String(value || "").match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  return match ? (match[1] || match[2] || match[3] || "") : "";
}

function imageNameFromUrl(value) {
  try {
    const url = new URL(decodeUrlMarkup(value), "https://planning.invalid/");
    return url.searchParams.get("ImageName") || url.searchParams.get("imagename") || null;
  } catch {
    const match = String(value || "").match(/[?&](?:ImageName|imagename)(?:=|%3D)(\d+)/i);
    return match?.[1] || null;
  }
}

function rowTextForOffset(html, offset) {
  const before = html.lastIndexOf("<tr", offset);
  const after = html.indexOf("</tr>", offset);
  if (before >= 0 && after >= 0) return decodeHtml(html.slice(before, after + 5));
  const start = Math.max(0, offset - 500);
  const end = Math.min(html.length, offset + 500);
  return decodeHtml(html.slice(start, end));
}

function sameHost(first, second) {
  try {
    return new URL(first).hostname.toLowerCase() === new URL(second).hostname.toLowerCase();
  } catch {
    return false;
  }
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

function addAttachment(seen, html, applicationUrl, rawHref, offset, title = "") {
  const href = decodeUrlMarkup(rawHref);
  if (!/AttachmentShowServlet/i.test(href)) return;
  let resolved;
  try {
    resolved = new URL(href, applicationUrl);
  } catch {
    return;
  }
  const imageName = imageNameFromUrl(resolved.toString());
  if (!imageName) return;
  const rowText = rowTextForOffset(html, offset);
  const cleanTitle = decodeHtml(title);
  const ranking = rankPlanningAttachment({ title: cleanTitle, rowText });
  const id = String(imageName);
  const candidate = {
    imageName: id,
    title: cleanTitle || null,
    rowText: rowText || null,
    url: resolved.toString().replace(/^http:/i, "https:"),
    transportUrl: resolved.toString().replace(/^https:/i, "http:"),
    tlsVerification: "legacy-http-official-host",
    ...ranking
  };
  const current = seen.get(id);
  if (!current || candidate.priority > current.priority || (candidate.title && !current.title)) seen.set(id, candidate);
}

export function parsePlanningApplicationAttachments(html, options = {}) {
  const source = String(html || "");
  const applicationUrl = options.applicationUrl || "https://planning.invalid/portal/servlets/ApplicationSearchServlet";
  const seen = new Map();

  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(anchorPattern)) {
    const href = hrefFromAttributes(match[1]);
    addAttachment(seen, source, applicationUrl, href, match.index || 0, match[2]);
  }

  // Older public-access portals frequently open document images from JavaScript
  // rather than a normal anchor. Scan the markup for those canonical servlet URLs
  // too, while still requiring an ImageName identifier and the same application host.
  const rawPattern = /(?:https?:\/\/[^"'<>\s)]+)?(?:\/[^"'<>\s)]*)?AttachmentShowServlet\?[^"'<>\s)]*(?:ImageName|imagename)(?:=|%3D)\d+[^"'<>\s)]*/gi;
  for (const match of source.matchAll(rawPattern)) {
    addAttachment(seen, source, applicationUrl, match[0], match.index || 0, "");
  }

  return [...seen.values()].sort((a, b) => b.priority - a.priority || Number(a.narrative) - Number(b.narrative) || a.imageName.localeCompare(b.imageName));
}

export function discoverPlanningDocumentNavigation(html, applicationUrl) {
  const source = String(html || "");
  const links = [];
  const seen = new Set();
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = decodeUrlMarkup(hrefFromAttributes(match[1]));
    const text = decodeHtml(match[2]);
    if (!href || (!DOCUMENT_NAV_TEXT.test(text) && !DOCUMENT_NAV_HREF.test(href))) continue;
    let resolved;
    try { resolved = new URL(href, applicationUrl); } catch { continue; }
    if (!sameHost(applicationUrl, resolved.toString())) continue;
    if (!/^https?:$/.test(resolved.protocol)) continue;
    if (/AttachmentShowServlet/i.test(resolved.pathname)) continue;
    const canonical = resolved.toString().replace(/^http:/i, "https:");
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    links.push({ url: canonical, transportUrl: canonical.replace(/^https:/i, "http:"), text });
  }
  return links.slice(0, 8);
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

async function fetchHtml(url, options, attempts, round = 0) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000));
  const response = await fetchImpl(url, {
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
  attempts.push({ url, round, status: response.status, bytes: Buffer.byteLength(html) });
  return { html, fetchedUrl: response.url || url };
}

export async function discoverPlanningApplicationAttachments(applicationUrl, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("planning attachment discovery requires fetch()");
  const urls = safeApplicationUrls(applicationUrl, options);
  const retries = Math.min(4, Math.max(0, Number(options.retries ?? 2)));
  const attempts = [];

  for (let round = 0; round <= retries; round += 1) {
    for (const candidate of urls) {
      try {
        const page = await fetchHtml(candidate, options, attempts, round);
        let attachments = parsePlanningApplicationAttachments(page.html, { applicationUrl: page.fetchedUrl || applicationUrl });
        const navigation = discoverPlanningDocumentNavigation(page.html, page.fetchedUrl || applicationUrl);
        const followed = [];

        if (!attachments.length) {
          for (const nav of navigation.slice(0, 4)) {
            const navCandidates = options.allowLegacyHttpTransport ? [nav.transportUrl, nav.url] : [nav.url];
            let navPage = null;
            for (const navUrl of navCandidates) {
              try {
                navPage = await fetchHtml(navUrl, options, attempts, round);
                break;
              } catch (error) {
                attempts.push({ url: navUrl, round, message: error?.message || String(error) });
                if (!error?.retryable && !retryable(error)) break;
              }
            }
            if (!navPage) continue;
            followed.push({ text: nav.text, url: nav.url, fetchedUrl: navPage.fetchedUrl });
            attachments = [...attachments, ...parsePlanningApplicationAttachments(navPage.html, { applicationUrl: navPage.fetchedUrl || nav.url })];
          }
          const byImage = new Map();
          for (const item of attachments) {
            const prior = byImage.get(item.imageName);
            if (!prior || item.priority > prior.priority) byImage.set(item.imageName, item);
          }
          attachments = [...byImage.values()].sort((a, b) => b.priority - a.priority || a.imageName.localeCompare(b.imageName));
        }

        return {
          status: "usable",
          applicationUrl,
          fetchedUrl: page.fetchedUrl || candidate,
          attachments,
          drawingAttachments: attachments.filter((item) => item.drawing),
          proposedDrawingAttachments: attachments.filter((item) => item.drawing && item.proposed),
          rideLayoutAttachments: attachments.filter((item) => item.rideLayout),
          navigation,
          followed,
          pageDiagnostics: {
            bytes: Buffer.byteLength(page.html),
            hasApplicationHeading: /Planning\s+Application/i.test(page.html),
            hasApplicationReference: /SMD\/2016\/0315/i.test(page.html),
            attachmentServletMentions: (page.html.match(/AttachmentShowServlet/gi) || []).length,
            navigationLinks: navigation.length
          },
          attempts: attempts.length,
          attemptLog: attempts
        };
      } catch (error) {
        attempts.push({ url: candidate, round, message: error?.message || String(error) });
        if (!error?.retryable && !retryable(error)) throw error;
      }
    }
  }
  throw new Error(`unable to discover planning attachments after ${attempts.length} attempts: ${attempts.at(-1)?.message || "unknown failure"}`);
}
