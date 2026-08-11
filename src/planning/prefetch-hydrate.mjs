import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

function safePath(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error("planning prefetch document path must be relative");
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`planning prefetch path escapes root: ${relative}`);
  return resolved;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function allowedCandidateUrls(entry, options = {}) {
  const primary = parseUrl(entry?.url || entry?.finalUrl);
  if (!primary || primary.protocol !== "https:") throw new Error(`planning document URL must be HTTPS: ${entry?.url || "missing"}`);
  const output = [primary];
  const transport = parseUrl(entry?.transportUrl);
  if (transport && transport.href !== primary.href) {
    const legacyAllowed = Boolean(options.allowLegacyHttpTransport)
      && transport.protocol === "http:"
      && transport.hostname === primary.hostname
      && String(entry?.tlsVerification || "") === "legacy-http-official-host";
    if (transport.protocol === "https:" || legacyAllowed) output.push(transport);
  }
  return output;
}

function finalUrlAllowed(responseUrl, primary, candidate, options = {}) {
  const final = parseUrl(responseUrl || candidate.href);
  if (!final) return false;
  if (final.protocol === "https:") return true;
  return Boolean(options.allowLegacyHttpTransport)
    && candidate.protocol === "http:"
    && final.protocol === "http:"
    && final.hostname === primary.hostname;
}

async function existingArtifactState(target, entry) {
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size !== Number(entry.bytes)) return { valid: false, exists: true };
    const sha256 = await sha256File(target);
    return { valid: sha256 === String(entry.sha256).toLowerCase(), exists: true, sha256 };
  } catch (error) {
    if (error?.code === "ENOENT") return { valid: false, exists: false };
    throw error;
  }
}

async function fetchVerified(entry, target, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("planning hydrator requires fetch()");
  const urls = allowedCandidateUrls(entry, options);
  const primary = urls[0];
  const expectedBytes = Number(entry.bytes);
  const expectedSha256 = String(entry.sha256 || "").toLowerCase();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) throw new Error(`invalid declared planning document bytes for ${entry.file}`);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error(`invalid declared planning document sha256 for ${entry.file}`);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 45000));
  const temp = `${target}.partial-${process.pid}-${Date.now()}`;
  let lastError = null;

  for (const candidate of urls) {
    await rm(temp, { force: true });
    try {
      const response = await fetchImpl(candidate.href, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": options.userAgent || "Project-Gen/0.1 planning-hydrator" }
      });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || "unknown"}`);
      if (!finalUrlAllowed(response.url, primary, candidate, options)) throw new Error(`unsafe redirect target ${response.url || "unknown"}`);
      const declaredLength = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > expectedBytes) {
        throw new Error(`content-length ${declaredLength} exceeds manifest bytes ${expectedBytes}`);
      }
      if (!response.body) throw new Error("response body missing");

      await mkdir(path.dirname(target), { recursive: true });
      const handle = await open(temp, "w");
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > expectedBytes) throw new Error(`download exceeded manifest bytes ${expectedBytes}`);
          hash.update(buffer);
          await handle.write(buffer);
        }
      } finally {
        await handle.close();
      }
      if (bytes !== expectedBytes) throw new Error(`download bytes mismatch expected=${expectedBytes} actual=${bytes}`);
      const sha256 = hash.digest("hex");
      if (sha256 !== expectedSha256) throw new Error(`download sha256 mismatch expected=${expectedSha256} actual=${sha256}`);
      await rename(temp, target);
      return { bytes, sha256, url: candidate.href, finalUrl: response.url || candidate.href };
    } catch (error) {
      lastError = error;
      await rm(temp, { force: true });
    }
  }
  throw new Error(`unable to hydrate ${entry.file}: ${lastError?.message || "all candidates failed"}`);
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function lane() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length || 1, Math.max(1, concurrency)) }, lane));
  return output;
}

export async function hydratePlanningPrefetch(directory, options = {}) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (Number(manifest.schemaVersion) !== 1) throw new Error(`unsupported planning manifest schemaVersion ${manifest.schemaVersion}`);
  if (!["usable", "disabled"].includes(manifest.status)) throw new Error(`invalid planning manifest status ${manifest.status}`);
  if (manifest.status === "disabled") return { status: "disabled", documents: 0, downloaded: 0, reused: 0, bytesDownloaded: 0, results: [] };
  if (!Array.isArray(manifest.entries)) throw new Error("planning manifest entries must be an array");

  const documents = manifest.entries.filter((entry) => entry?.kind === "document" && entry?.file && entry?.sha256 && entry?.bytes);
  const maxDocuments = Math.max(1, Number(options.maxDocuments || 1200));
  if (documents.length > maxDocuments) throw new Error(`planning manifest has ${documents.length} documents; max is ${maxDocuments}`);
  const concurrency = Math.min(12, Math.max(1, Number(options.concurrency || 4)));
  const results = await mapConcurrent(documents, concurrency, async (entry) => {
    const target = safePath(root, entry.file);
    const existing = await existingArtifactState(target, entry);
    if (existing.valid) return { file: entry.file, status: "reused", bytes: Number(entry.bytes), sha256: existing.sha256 };
    if (existing.exists) await rm(target, { force: true });
    const downloaded = await fetchVerified(entry, target, options);
    return { file: entry.file, status: "downloaded", ...downloaded };
  });

  return {
    status: "usable",
    documents: documents.length,
    downloaded: results.filter((result) => result.status === "downloaded").length,
    reused: results.filter((result) => result.status === "reused").length,
    bytesDownloaded: results.filter((result) => result.status === "downloaded").reduce((sum, result) => sum + Number(result.bytes || 0), 0),
    results
  };
}

export { allowedCandidateUrls, safePath, sha256File };
