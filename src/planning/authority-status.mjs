const POSITIVE_STATUS_PATTERNS = [
  /^approved$/,
  /^granted$/,
  /^permitted$/,
  /^consented$/,
  /^lawful$/,
  /\bapproved\b/,
  /\bgranted\b/,
  /\bpermitted\b/,
  /\bconsented\b/,
  /\blawful\b/
];

const NON_AUTHORITY_STATUS_PATTERNS = [
  /withdrawn/,
  /refused/,
  /rejected/,
  /declined/,
  /dismissed/,
  /invalid/,
  /pending/,
  /awaiting/,
  /undetermined/,
  /unknown/,
  /cancelled|canceled/
];

export function normalizePlanningApplicationStatus(value) {
  const normalized = String(value ?? "unknown").trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || "unknown";
}

export function planningApplicationWorldAuthorityEligible(status) {
  const normalized = normalizePlanningApplicationStatus(status);
  if (NON_AUTHORITY_STATUS_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return POSITIVE_STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function planningApplicationAuthorityReason(status) {
  const normalized = normalizePlanningApplicationStatus(status);
  return planningApplicationWorldAuthorityEligible(normalized)
    ? "positive-final-planning-status"
    : `non-authoritative-application-status:${normalized}`;
}
