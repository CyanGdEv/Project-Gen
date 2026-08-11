const EARTH_RADIUS_M = 6371008.8;

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function clampInteger(value, fallback, min, max) {
  return Math.round(clampNumber(value, fallback, min, max));
}

export function haversineM(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = Number(a.latitude ?? a.lat);
  const lon1 = Number(a.longitude ?? a.lon ?? a.lng);
  const lat2 = Number(b.latitude ?? b.lat);
  const lon2 = Number(b.longitude ?? b.lon ?? b.lng);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const p1 = lat1 * toRad;
  const p2 = lat2 * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function registrationVariantScore(candidate) {
  const quality = candidate?.quality || {};
  return Number(candidate?.confidence || 0) * 2
    + Number(quality.f1 ?? quality.score ?? 0)
    + Number(quality.precision || 0) * 0.25
    + Number(quality.recall || 0) * 0.25;
}

export function registrationVariants(result, minimumConfidence = 0.72) {
  const primary = result?.automaticCandidate;
  if (!primary) return [];
  const variants = [];
  for (const candidate of [primary, ...(Array.isArray(primary.alternatives) ? primary.alternatives : [])]) {
    if (!candidate?.candidateLocation || Number(candidate.confidence || 0) < minimumConfidence) continue;
    if (variants.some((existing) => haversineM(existing.candidateLocation, candidate.candidateLocation) < 8)) continue;
    variants.push(candidate);
    if (variants.length >= 12) break;
  }
  return variants;
}

export function automaticConsensusGroups(results, options = {}) {
  const maxSeparationM = clampNumber(options.planningAutomaticRegistrationConsensusM, 140, 20, 1000);
  const minimumConfidence = clampNumber(options.planningAutomaticRegistrationMinConfidence, 0.72, 0.5, 0.99);
  const minimumDocuments = clampInteger(options.planningAutomaticRegistrationConsensusDocuments, 2, 2, 8);
  const grouped = new Map();

  for (const result of results || []) {
    const variants = registrationVariants(result, minimumConfidence);
    if (!variants.length) continue;
    const key = result.applicationReference || "unknown";
    const list = grouped.get(key) || [];
    list.push({ result, variants });
    grouped.set(key, list);
  }

  const accepted = new Set();
  const selectedCandidates = new Map();
  const evidence = [];

  for (const [applicationReference, entries] of grouped) {
    let best = null;
    for (const entry of entries) {
      for (const anchor of entry.variants) {
        const members = [];
        for (const other of entries) {
          const nearest = other.variants
            .map((candidate) => ({ candidate, distanceM: haversineM(anchor.candidateLocation, candidate.candidateLocation) }))
            .filter((value) => value.distanceM <= maxSeparationM)
            .sort((a, b) => a.distanceM - b.distanceM || registrationVariantScore(b.candidate) - registrationVariantScore(a.candidate))[0];
          if (nearest) members.push({ result: other.result, candidate: nearest.candidate, distanceM: nearest.distanceM });
        }
        const uniqueDocuments = new Set(members.map((member) => member.result.sourceSha256 || member.result.id));
        const spreadM = members.length ? Math.max(...members.map((member) => member.distanceM)) : Infinity;
        const quality = members.reduce((total, member) => total + registrationVariantScore(member.candidate), 0);
        const score = uniqueDocuments.size * 10000 + quality * 100 - spreadM;
        if (!best || score > best.score) best = { score, members, uniqueDocuments, spreadM };
      }
    }

    const consensusDocuments = best?.uniqueDocuments.size || 0;
    const isAccepted = consensusDocuments >= minimumDocuments;
    if (isAccepted) {
      for (const member of best.members) {
        accepted.add(member.result.id);
        selectedCandidates.set(member.result.id, member.candidate);
      }
    }
    evidence.push({
      applicationReference,
      candidates: entries.length,
      candidateVariants: entries.reduce((total, entry) => total + entry.variants.length, 0),
      consensusDocuments,
      accepted: isAccepted,
      maximumSeparationM: maxSeparationM,
      selectedSpreadM: Number.isFinite(best?.spreadM) ? Math.round(best.spreadM * 10) / 10 : null,
      selectedAlternativeDocuments: isAccepted ? best.members.filter((member) => Number(member.candidate.alternativeRank || 0) > 0).length : 0
    });
  }

  return { accepted, selectedCandidates, evidence, minimumDocuments, minimumConfidence, maxSeparationM };
}
