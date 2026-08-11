export const GENERATION_BUDGET_MS = 300000;

export const PHASE_BUDGET_MS = Object.freeze({
  bootstrap: 15000,
  acquisition: 65000,
  planning: 80000,
  fusion: 30000,
  worldCompile: 75000,
  validateAndPackage: 25000,
  reserve: 10000
});

export function validateBudget(phases = PHASE_BUDGET_MS, total = GENERATION_BUDGET_MS) {
  const sum = Object.values(phases).reduce((acc, value) => acc + Number(value), 0);
  if (sum > total) throw new Error(`phase budget ${sum}ms exceeds generation budget ${total}ms`);
  return { totalMs: total, allocatedMs: sum, reserveMs: total - sum };
}
