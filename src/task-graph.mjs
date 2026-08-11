function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

export async function runTaskGraph(tasks, options = {}) {
  const concurrency = Math.max(1, Number(options.concurrency || 4));
  const deadlineMs = Math.max(1, Number(options.deadlineMs || 300000));
  const startedAt = nowMs();
  const taskMap = new Map(tasks.map((task) => [task.id, task]));

  if (taskMap.size !== tasks.length) throw new Error("task ids must be unique");
  for (const task of tasks) {
    if (!task?.id || typeof task.run !== "function") throw new Error("each task needs id and run()");
    for (const dependency of task.deps || []) {
      if (!taskMap.has(dependency)) throw new Error(`unknown dependency ${dependency} for ${task.id}`);
    }
  }

  const completed = new Map();
  const metrics = [];
  const pending = new Set(taskMap.keys());

  while (pending.size) {
    const elapsed = nowMs() - startedAt;
    if (elapsed >= deadlineMs) throw new Error(`generation deadline exceeded after ${elapsed}ms`);

    const ready = [...pending]
      .map((id) => taskMap.get(id))
      .filter((task) => (task.deps || []).every((dep) => completed.has(dep)));

    if (!ready.length) {
      throw new Error(`task graph deadlock: ${[...pending].join(", ")}`);
    }

    for (let offset = 0; offset < ready.length; offset += concurrency) {
      const batch = ready.slice(offset, offset + concurrency);
      await Promise.all(batch.map(async (task) => {
        const taskStart = nowMs();
        const deps = Object.fromEntries((task.deps || []).map((dep) => [dep, completed.get(dep)]));
        const value = await task.run({ deps, elapsedMs: nowMs() - startedAt, deadlineMs });
        completed.set(task.id, value);
        pending.delete(task.id);
        metrics.push({ id: task.id, durationMs: nowMs() - taskStart });
      }));
    }
  }

  return {
    results: Object.fromEntries(completed),
    metrics: metrics.sort((a, b) => a.id.localeCompare(b.id)),
    durationMs: nowMs() - startedAt
  };
}
