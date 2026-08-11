import { createHash } from "node:crypto";
import { contentKey } from "../cache.mjs";

export const HTTP_JSON_ADAPTER_VERSION = 1;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [String(key).toLowerCase(), String(value)])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function responseHeader(response, name) {
  return response.headers?.get?.(name) || null;
}

function staleFallback(cached, now, staleIfErrorMs, error) {
  if (!cached || staleIfErrorMs <= 0) return null;
  const ageMs = Math.max(0, now - Number(cached.fetchedAt || 0));
  if (ageMs > staleIfErrorMs) return null;
  return {
    ...cached.result,
    cacheHit: true,
    cacheMode: "stale-if-error",
    provenance: {
      ...(cached.result?.provenance || {}),
      staleAt: now,
      staleAgeMs: ageMs,
      staleReason: error?.message || String(error)
    }
  };
}

export function createHttpJsonAdapter(options = {}) {
  const id = String(options.id || "").trim().toLowerCase();
  if (!id) throw new Error("HTTP JSON adapter requires id");
  if (typeof options.buildRequest !== "function") throw new Error(`${id} adapter requires buildRequest()`);

  const freshForMs = Math.max(0, Number(options.freshForMs ?? 6 * 60 * 60 * 1000));
  const staleIfErrorMs = Math.max(0, Number(options.staleIfErrorMs ?? 0));
  const maxBytes = Math.max(1024, Number(options.maxBytes ?? 25 * 1024 * 1024));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 25000));

  return Object.freeze({
    id,
    async acquire(context = {}) {
      const request = options.buildRequest(context.request || {});
      if (!request?.url) throw new Error(`${id} request is missing url`);
      const url = new URL(request.url);
      if (url.protocol !== "https:") throw new Error(`${id} source URL must use HTTPS`);
      const method = String(request.method || "GET").toUpperCase();
      const headers = normalizedHeaders(request.headers);
      const body = request.body == null ? null : String(request.body);
      const requestKey = contentKey(`http-json-${id}`, {
        adapterVersion: HTTP_JSON_ADAPTER_VERSION,
        url: url.toString(),
        method,
        headers,
        body
      });
      const cache = context.cache || options.cache || null;
      const now = Number(context.now ?? Date.now());
      const cached = cache ? await cache.get(requestKey) : null;

      if (cached && freshForMs > 0 && now - Number(cached.fetchedAt || 0) <= freshForMs) {
        return { ...cached.result, cacheHit: true, cacheMode: "fresh" };
      }

      const fetchImpl = context.fetchImpl || options.fetchImpl || globalThis.fetch;
      if (typeof fetchImpl !== "function") throw new Error(`${id} source requires fetch`);
      const conditionalHeaders = { ...headers };
      if (cached?.etag) conditionalHeaders["if-none-match"] = cached.etag;
      if (cached?.lastModified) conditionalHeaders["if-modified-since"] = cached.lastModified;

      const graphRemainingMs = Number.isFinite(Number(context.deadlineMs))
        ? Math.max(1, Number(context.deadlineMs) - Number(context.elapsedMs || 0))
        : timeoutMs;
      const requestTimeoutMs = Math.max(1, Math.min(timeoutMs, graphRemainingMs));
      const signal = context.signal || AbortSignal.timeout(requestTimeoutMs);

      try {
        const response = await fetchImpl(url, { method, headers: conditionalHeaders, body, signal });
        if (response.status === 304 && cached) {
          const refreshed = { ...cached, fetchedAt: now };
          if (cache) await cache.put(requestKey, refreshed);
          return { ...cached.result, cacheHit: true, cacheMode: "revalidated" };
        }
        if (!response.ok) throw new Error(`${id} source request failed with HTTP ${response.status}`);

        const declaredLength = Number(responseHeader(response, "content-length") || 0);
        if (declaredLength > maxBytes) throw new Error(`${id} source response exceeds byte ceiling`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) throw new Error(`${id} source response exceeds byte ceiling`);
        let payload;
        try {
          payload = JSON.parse(bytes.toString("utf8"));
        } catch (error) {
          throw new Error(`${id} source returned invalid JSON: ${error.message}`);
        }

        const contentSha256 = sha256(bytes);
        const result = {
          source: id,
          status: "usable",
          cacheHit: false,
          cacheMode: cached ? "refreshed" : "miss",
          payload,
          provenance: {
            url: url.toString(),
            fetchedAt: now,
            etag: responseHeader(response, "etag"),
            lastModified: responseHeader(response, "last-modified"),
            contentSha256,
            bytes: bytes.length
          }
        };
        if (cache) {
          await cache.put(requestKey, {
            fetchedAt: now,
            etag: result.provenance.etag,
            lastModified: result.provenance.lastModified,
            result
          });
        }
        return result;
      } catch (error) {
        const stale = staleFallback(cached, now, staleIfErrorMs, error);
        if (stale) return stale;
        throw error;
      }
    }
  });
}
