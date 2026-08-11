function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function createPlanningProcessorProfiler(processors, options = {}) {
  if (!processors || typeof processors !== "object") throw new Error("planning profiler requires processors");
  const methodNames = options.methods || [
    "renderPage",
    "extractSemantics",
    "resolveStrongGeoreference",
    "registerPage",
    "vectorizePage"
  ];
  const stats = {};
  const wrapped = { ...processors };

  for (const name of methodNames) {
    if (typeof processors[name] !== "function") continue;
    stats[name] = { calls: 0, totalMs: 0, maxMs: 0, failures: 0 };
    wrapped[name] = async (...args) => {
      const startedAt = nowMs();
      stats[name].calls += 1;
      try {
        return await processors[name](...args);
      } catch (error) {
        stats[name].failures += 1;
        throw error;
      } finally {
        const elapsed = nowMs() - startedAt;
        stats[name].totalMs += elapsed;
        stats[name].maxMs = Math.max(stats[name].maxMs, elapsed);
      }
    };
  }

  return {
    processors: wrapped,
    snapshot() {
      return Object.fromEntries(Object.entries(stats).map(([name, value]) => [name, {
        calls: value.calls,
        failures: value.failures,
        totalMs: roundMs(value.totalMs),
        maxMs: roundMs(value.maxMs),
        averageMs: value.calls ? roundMs(value.totalMs / value.calls) : 0
      }]));
    }
  };
}

export function createTimingAccumulator() {
  const values = new Map();
  return {
    async measure(name, work) {
      const startedAt = nowMs();
      try {
        return await work();
      } finally {
        const elapsed = nowMs() - startedAt;
        const current = values.get(name) || { calls: 0, totalMs: 0, maxMs: 0 };
        current.calls += 1;
        current.totalMs += elapsed;
        current.maxMs = Math.max(current.maxMs, elapsed);
        values.set(name, current);
      }
    },
    snapshot() {
      return Object.fromEntries([...values.entries()].map(([name, value]) => [name, {
        calls: value.calls,
        totalMs: roundMs(value.totalMs),
        maxMs: roundMs(value.maxMs),
        averageMs: value.calls ? roundMs(value.totalMs / value.calls) : 0
      }]));
    }
  };
}
