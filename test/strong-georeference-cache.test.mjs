import test from "node:test";
import assert from "node:assert/strict";
import { planningStrongGeoreferenceKey } from "../src/planning/cache-keys.mjs";

test("legacy strong-georeference callers are forced onto null-safe geofence-scoped v3 keys", () => {
  const bbox = [52.97, -1.90, 53.00, -1.85];
  const input = { documentSha256: "doc", page: 1, pageSha256: "page", semanticHash: "semantic", bbox };
  const legacyCaller = planningStrongGeoreferenceKey({ ...input, version: "strong-georef-v1" });
  const v2Caller = planningStrongGeoreferenceKey({ ...input, version: "strong-georef-v2-null-safe" });
  const safeVersion = planningStrongGeoreferenceKey({ ...input, version: "strong-georef-v3-null-safe-geofence" });
  const otherPark = planningStrongGeoreferenceKey({ ...input, bbox: [51.0, -0.2, 51.1, -0.1], version: "strong-georef-v3-null-safe-geofence" });
  assert.equal(legacyCaller, safeVersion);
  assert.equal(v2Caller, safeVersion);
  assert.notEqual(otherPark, safeVersion);
});
