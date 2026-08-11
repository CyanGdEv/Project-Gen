import test from "node:test";
import assert from "node:assert/strict";
import { planningStrongGeoreferenceKey } from "../src/planning/cache-keys.mjs";

test("legacy v1 strong-georeference callers are forced onto null-safe v2 cache keys", () => {
  const input = { documentSha256: "doc", page: 1, pageSha256: "page", semanticHash: "semantic" };
  const legacyCaller = planningStrongGeoreferenceKey({ ...input, version: "strong-georef-v1" });
  const safeVersion = planningStrongGeoreferenceKey({ ...input, version: "strong-georef-v2-null-safe" });
  const oldUnsafeKey = planningStrongGeoreferenceKey({ ...input, version: "strong-georef-v1-unsafe-fixture" });
  assert.equal(legacyCaller, safeVersion);
  assert.notEqual(legacyCaller, oldUnsafeKey);
});
