import { contentKey } from "../cache.mjs";

export function planningRenderKey({ documentSha256, page, dpi = 240, rendererVersion = "render-v1" }) {
  return contentKey("planning-render", { documentSha256, page, dpi, rendererVersion });
}

export function planningSemanticKey({ pageSha256, extractorVersion = "semantic-v1" }) {
  return contentKey("planning-semantic", { pageSha256, extractorVersion });
}

export function planningStrongGeoreferenceKey({ documentSha256, page, pageSha256, semanticHash, version = "strong-georef-v2-null-safe" }) {
  // v1 could coerce missing/null controls to numeric zero. Treat every legacy
  // v1 caller as v2 so a stale accepted (0,0) control result can never survive
  // the null-safety behavior change in an existing warm cache.
  const cacheVersion = version === "strong-georef-v1" ? "strong-georef-v2-null-safe" : version;
  return contentKey("planning-strong-georeference", { documentSha256, page, pageSha256, semanticHash, version: cacheVersion });
}

export function planningRegistrationKey({ pageSha256, referenceHash, registrationVersion = "registration-v1", bbox = null, locationPrior = null }) {
  return contentKey("planning-registration", { pageSha256, referenceHash, registrationVersion, bbox, locationPrior });
}

export function planningVectorKey({ pageSha256, semanticHash, transformHash, vectorizerVersion = "vector-v1" }) {
  return contentKey("planning-vector", { pageSha256, semanticHash, transformHash, vectorizerVersion });
}
