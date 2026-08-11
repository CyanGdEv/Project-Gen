import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

const MIME_EXTENSIONS = Object.freeze({
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/tiff": ".tiff"
});

function sameOfficialHost(first, second) {
  try {
    return new URL(first).hostname === new URL(second).hostname;
  } catch {
    return false;
  }
}

function candidateUrls(attachment, options = {}) {
  const primary = new URL(attachment.url);
  if (primary.protocol !== "https:") throw new Error(`discovered planning attachment must have HTTPS canonical URL: ${attachment.url}`);
  const urls = [primary.toString()];
  if (options.allowLegacyHttpTransport && attachment.transportUrl && sameOfficialHost(primary, attachment.transportUrl)) {
    const legacy = new URL(attachment.transportUrl);
    if (legacy.protocol === "http:" && String(attachment.tlsVerification || "") === "legacy-http-official-host") urls.unshift(legacy.toString());
  }
  return [...new Set(urls)];
}

function responseMime(response) {
  return String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
}

async function downloadOne(attachment, directory, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("discovered planning hydration requires fetch()");
  const maxBytes = Math.max(1024, Number(options.maxBytes || 50 * 1024 * 1024));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 45000));
  const root = path.resolve(directory);
  await mkdir(path.join(root, "files"), { recursive: true });
  let lastError = null;

  for (const url of candidateUrls(attachment, options)) {
    const temp = path.join(root, "files", `.discovered-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.partial`);
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": options.userAgent || "Project-Gen/0.1 planning-discovered-hydrator" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const finalUrl = response.url || url;
      if (!sameOfficialHost(attachment.url, finalUrl)) throw new Error(`discovered attachment redirected off official host: ${finalUrl}`);
      const mime = responseMime(response) || "application/pdf";
      const extension = MIME_EXTENSIONS[mime];
      if (!extension) throw new Error(`unsupported discovered planning MIME ${mime || "missing"}`);
      const declared = Number(response.headers?.get?.("content-length") || 0);
      if (declared > maxBytes) throw new Error(`discovered planning attachment exceeds ${maxBytes} byte ceiling`);
      if (!response.body) throw new Error("discovered planning response body missing");

      const handle = await open(temp, "w");
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxBytes) throw new Error(`discovered planning attachment exceeded ${maxBytes} byte ceiling while streaming`);
          hash.update(buffer);
          await handle.write(buffer);
        }
      } finally {
        await handle.close();
      }
      if (!bytes) throw new Error("discovered planning attachment is empty");
      const sha256 = hash.digest("hex");
      const relative = `files/${sha256}${extension}`;
      const target = path.join(root, relative);
      try {
        await rename(temp, target);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await rm(temp, { force: true });
      }
      return {
        kind: "document",
        source: "planning",
        discovery: "official-application-attachment",
        applicationReference: attachment.applicationReference || options.applicationReference || null,
        applicationStatus: attachment.applicationStatus || options.applicationStatus || null,
        imageName: attachment.imageName || null,
        title: attachment.title || null,
        role: attachment.classification || null,
        priority: Number(attachment.priority || 0),
        proposed: Boolean(attachment.proposed),
        rideLayout: Boolean(attachment.rideLayout),
        url: attachment.url,
        finalUrl,
        transportUrl: attachment.transportUrl || null,
        tlsVerification: attachment.tlsVerification || null,
        file: relative,
        bytes,
        sha256,
        mime
      };
    } catch (error) {
      lastError = error;
      await rm(temp, { force: true });
    }
  }
  throw new Error(`unable to hydrate discovered planning attachment ${attachment.imageName || attachment.title || "unknown"}: ${lastError?.message || "all transports failed"}`);
}

export function selectDiscoveredPlanningDrawings(discovery, options = {}) {
  const maxDocuments = Math.max(1, Number(options.maxDocuments || 12));
  return (discovery?.attachments || [])
    .filter((item) => item?.drawing && !item?.narrative)
    .sort((a, b) => Number(b.rideLayout) - Number(a.rideLayout)
      || Number(b.proposed) - Number(a.proposed)
      || Number(b.priority || 0) - Number(a.priority || 0)
      || String(a.imageName || "").localeCompare(String(b.imageName || "")))
    .slice(0, maxDocuments);
}

export async function hydrateDiscoveredPlanningDrawings(discovery, directory, options = {}) {
  const selected = selectDiscoveredPlanningDrawings(discovery, options);
  const results = [];
  for (const attachment of selected) {
    results.push(await downloadOne(attachment, directory, options));
  }
  return {
    schemaVersion: 1,
    status: "usable",
    source: "official-planning-attachment-discovery",
    applicationUrl: discovery?.applicationUrl || null,
    documents: results,
    totalBytes: results.reduce((sum, item) => sum + item.bytes, 0),
    rideLayoutDocuments: results.filter((item) => item.rideLayout).length,
    proposedDocuments: results.filter((item) => item.proposed).length
  };
}
