import { runTaskGraph } from "./task-graph.mjs";

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new Error("source adapter must be an object");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(adapter.id || ""))) throw new Error("source adapter has invalid id");
  if (typeof adapter.acquire !== "function") throw new Error(`source adapter ${adapter.id} requires acquire()`);
}

export async function acquireSources(adapters, request, options = {}) {
  if (!Array.isArray(adapters) || !adapters.length) throw new Error("at least one source adapter is required");
  for (const adapter of adapters) validateAdapter(adapter);
  const unique = new Set(adapters.map((adapter) => adapter.id));
  if (unique.size !== adapters.length) throw new Error("source adapter ids must be unique");

  const failOpen = new Set((options.failOpen || []).map(String));
  const tasks = adapters.map((adapter) => ({
    id: `source:${adapter.id}`,
    run: async ({ elapsedMs, deadlineMs }) => {
      try {
        const result = await adapter.acquire({
          request,
          cache: options.cache,
          fetchImpl: options.fetchImpl,
          now: options.now,
          elapsedMs,
          deadlineMs
        });
        return { ...result, source: result?.source || adapter.id };
      } catch (error) {
        if (!failOpen.has(adapter.id)) throw error;
        return {
          source: adapter.id,
          status: "unavailable",
          cacheHit: false,
          error: error?.message || String(error)
        };
      }
    }
  }));

  const graph = await runTaskGraph(tasks, {
    concurrency: Math.max(1, Number(options.concurrency || adapters.length)),
    deadlineMs: Math.max(1, Number(options.deadlineMs || 65000))
  });
  const sources = Object.fromEntries(
    adapters.map((adapter) => [adapter.id, graph.results[`source:${adapter.id}`]])
  );
  return {
    sources,
    metrics: graph.metrics.map((metric) => ({ ...metric, source: metric.id.replace(/^source:/, "") })),
    durationMs: graph.durationMs
  };
}
