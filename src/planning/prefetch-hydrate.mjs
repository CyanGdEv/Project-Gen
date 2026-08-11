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
  const transport = parseUrl(entry?.transportUrl);
  if (!transport || transport.href === primary.href) return [primary];

  const legacyAllowed = Boolean(options.allowLegacyHttpTransport)
    && transport.protocol === "http:"
    && transport.hostname === primary.hostname
    && String(entry?.tlsVerification || "") === "legacy-http-official-host";
  if (legacyAllowed) return [transport, primary];
  if (transport.protocol === "https:") return [primary, transport];
  return [primary];
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

function retryableHttpStatus(status) {
  const value = Number(status);
  return value === 408 || value === 425 || value === 429 || value >= 500;
}

function retryableDownloadError(error) {
  if (error?.retryable === true) return true;
  if (error?.integrityFailure === true) return false;
  const code = String(error?.code || "").toUpperCase();
  if (["ABORT_ERR", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) return true;
  const name = String(error?.name || "");
  return name === "AbortError" || name === "TimeoutError" || /fetch failed/i.test(String(error?.message || ""));
}

function downloadError(message, options = {}) {
  const error = new Error(message);
  if (options.retryable) error.retryable = true;
  if (options.integrityFailure) error.integrityFailure = true;
  if (options.code) error.code = options.code;
  return error;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
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

async function fetchCandidateVerified({ entry, target, candidate, primary, expectedBytes, expectedSha256, fetchImpl, options, attemptTimeoutMs, temp }) {
  await rm(temp, { force: true });
  const response = await fetchImpl(candidate.href, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(attemptTimeoutMs),
    headers: { "user-agent": options.userAgent || "Project-Gen/0.1 planning-hydrator" }
  });
  if (!response?.ok) {
    throw downloadError(`HTTP ${response?.status || "unknown"}`, {
      retryable: retryableHttpStatus(response?.status),
      code: `HTTP_${response?.status || "UNKNOWN"}`
    });
  }
  if (!finalUrlAllowed(response.url, primary, candidate, options)) {
    throw downloadError(`unsafe redirect target ${response.url || "unknown"}`, { integrityFailure: true, code: "UNSAFE_REDIRECT" });
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > expectedBytes) {
    throw downloadError(`content-length ${declaredLength} exceeds manifest bytes ${expectedBytes}`, { integrityFailure: true, code: "CONTENT_LENGTH_EXCEEDS_MANIFEST" });
  }
  if (!response.body) throw downloadError("response body missing", { retryable: true, code: "MISSING_RESPONSE_BODY" });

  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(temp, "w");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > expectedBytes) {
        throw downloadError(`download exceeded manifest bytes ${expectedBytes}`, { integrityFailure: true, code: "DOWNLOAD_EXCEEDS_MANIFEST" });
      }
      hash.update(buffer);
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }
  if (bytes !== expectedBytes) {
    throw downloadError(`download bytes mismatch expected=${expectedBytes} actual=${bytes}`, { integrityFailure: true, code: "DOWNLOAD_BYTES_MISMATCH" });
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== expectedSha256) {
    throw downloadError(`download sha256 mismatch expected=${expectedSha256} actual=${sha256}`, { integrityFailure: true, code: "DOWNLOAD_SHA256_MISMATCH" });
  }
  await rename(temp, target);
  return { bytes, sha256, url: candidate.href, finalUrl: response.url || candidate.href };
}

async function fetchVerified(entry, target, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("planning hydrator requires fetch()");
  const primary = parseUrl(entry?.url || entry?.finalUrl);
  const urls = allowedCandidateUrls(entry, options);
  const expectedBytes = Number(entry.bytes);
  const expectedSha256 = String(entry.sha256 || "").toLowerCase();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) throw new Error(`invalid declared planning document bytes for ${entry.file}`);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error(`invalid declared planning document sha256 for ${entry.file}`);

  const retries = Math.min(5, Math.max(0, Number(options.retries ?? 2)));
  const attemptTimeoutMs = Math.max(1000, Number(options.attemptTimeoutMs || Math.min(Number(options.timeoutMs || 45000), 20000)));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 250));
  const temp = `${target}.partial-${process.pid}-${Date.now()}`;
  const attempts = [];
  let lastError = null;

  for (let round = 0; round <= retries; round += 1) {
    for (let candidateIndex = 0; candidateIndex < urls.length; candidateIndex += 1) {
      const candidate = urls[(candidateIndex + round) % urls.length];
      try {
        const downloaded = await fetchCandidateVerified({
          entry,
          target,
          candidate,
          primary,
          expectedBytes,
          expectedSha256,
          fetchImpl,
          options,
          attemptTimeoutMs,
          temp
        });
        return {
          ...downloaded,
          attempts: attempts.length + 1,
          retriesUsed: round
        };
      } catch (error) {
        lastError = error;
        attempts.push({
          url: candidate.href,
          round,
          code: error?.code || null,
          retryable: retryableDownloadError(error),
          message: error?.message || String(error)
        });
        await rm(temp, { force: true });
        if (!retryableDownloadError(error)) {
          throw new Error(`unable to hydrate ${entry.file}: ${error.message}`);
        }
      }
    }
    if (round < retries) await sleep(retryDelayMs * (round + 1));
  }

  const detail = attempts.slice(-4).map((attempt) => `${attempt.url} ${attempt.code || "error"}: ${attempt.message}`).join(" | ");
  throw new Error(`unable to hydrate ${entry.file} after ${attempts.length} attempts: ${lastError?.message || "all candidates failed"}${detail ? ` (${detail})` : ""}`);
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  let stopped = false;
  async function lane() {
    while (!stopped) {
      const index = next++;
      if (index >= items.length) return;
      try {
        output[index] = await worker(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
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
    if (existing.valid) return { file: entry.file, status: "reused", bytes: Number(entry.bytes), sha256: existing.sha256, attempts: 0, retriesUsed: 0 };
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
    totalAttempts: results.reduce((sum, result) => sum + Number(result.attempts || 0), 0),
    retriedDocuments: results.filter((result) => Number(result.retriesUsed || 0) > 0 || Number(result.attempts || 0) > 1).length,
    results
  };
}

export { allowedCandidateUrls, retryableDownloadError, retryableHttpStatus, safePath, sha256File };
