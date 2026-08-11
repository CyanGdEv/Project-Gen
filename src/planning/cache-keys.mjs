import { contentKey } from "../cache.mjs";

export function planningRenderKey({ documentSha256, page, dpi = 240, rendererVersion = "render-v1" }) {
  return contentKey("planning-render", { documentSha256, page, dpi, rendererVersion });
}

export function planningSemanticKey({ pageSha256, extractorVersion = "semantic-v1" }) {
  return contentKey("planning-semantic", { pageSha256, extractorVersion });
}

export function planningRegistrationKey({ pageSha256, referenceHash, registrationVersion = "registration-v1", bbox = null, locationPrior = null }) {
  return contentKey("planning-registration", { pageSha256, referenceHash, registrationVersion, bbox, locationPrior });
}

export function planningVectorKey({ pageSha256, semanticHash, transformHash, vectorizerVersion = "vector-v1" }) {
  return contentKey("planning-vector", { pageSha256, semanticHash, transformHash, vectorizerVersion });
}
