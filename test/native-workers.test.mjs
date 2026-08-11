import test from "node:test";
import assert from "node:assert/strict";
import { extractScaleDenominators, nativePlanningWorkerSelfTest } from "../src/planning/native-workers.mjs";

test("planning worker extracts explicit drawing scale denominators", () => {
  assert.deepEqual(extractScaleDenominators("Proposed site plan Scale 1:500 and detail 1/100"), [100, 500]);
  assert.deepEqual(extractScaleDenominators("NTS 1:25000"), []);
});

test("native OpenCV worker preserves bounded ROI registration kernel", async () => {
  const result = await nativePlanningWorkerSelfTest();
  assert.equal(result.status, "ok");
  assert.ok(result.f1 >= 0.70);
  assert.ok(result.precision >= 0.70);
  assert.ok(result.recall >= 0.70);
});
