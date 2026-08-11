import { contentKey } from "../cache.mjs";

export function planningRenderKey({ documentSha256, page, dpi = 240, rendererVersion = "render-v1" }) {
  return contentKey("planning-render", { documentSha256, page, dpi, rendererVersion });
}

export function planningSemanticKey({ pageSha256, extractorVersion = "semantic-v1" }) {
  return contentKey("planning-semantic", { pageSha256, extractorVersion });
}

export function planningStrongGeoreferenceKey({ documentSha256, page, pageSha256, semanticHash, bbox = null, version = "strong-georef-v3-null-safe-geofence" }) {
  // v1 could coerce missing/null controls to numeric zero and v2 did not scope
  // cached acceptance to the request geofence. Force legacy callers onto v3,
  // where bbox participates in the cache key so cross-park reuse is impossible.
  const cacheVersion = ["strong-georef-v1", "strong-georef-v2-null-safe"].includes(version)
    ? "strong-georef-v3-null-safe-geofence"
    : version;
  return contentKey("planning-strong-georeference", { documentSha256, page, pageSha256, semanticHash, bbox, version: cacheVersion });
}

export function planningRegistrationKey({ pageSha256, referenceHash, registrationVersion = "registration-v1", bbox = null, locationPrior = null }) {
  return contentKey("planning-registration", { pageSha256, referenceHash, registrationVersion, bbox, locationPrior });
}

export function planningVectorKey({ pageSha256, semanticHash, transformHash, vectorizerVersion = "vector-v1" }) {
  return contentKey("planning-vector", { pageSha256, semanticHash, transformHash, vectorizerVersion });
}
