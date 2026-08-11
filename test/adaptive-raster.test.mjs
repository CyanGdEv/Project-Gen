import test from "node:test";
import assert from "node:assert/strict";
import { choosePlanningRasterDpi, parsePdfPageSize } from "../src/planning/native-workers.mjs";

test("PDF page-size parser reads numbered Poppler page dimensions", () => {
  const parsed = parsePdfPageSize("Pages: 1\nPage 1 size: 2383.94 x 1683.78 pts (A1)\n", 1);
  assert.deepEqual(parsed, { widthPoints: 2383.94, heightPoints: 1683.78 });
});

test("adaptive raster keeps small plans at requested DPI and caps A1/A0 pixel cost", () => {
  assert.equal(choosePlanningRasterDpi(240, { widthPoints: 1190.55, heightPoints: 841.89 }), 240);
  const a1 = choosePlanningRasterDpi(240, { widthPoints: 2383.94, heightPoints: 1683.78 });
  assert.ok(a1 >= 150 && a1 <= 160, `expected A1 around 157dpi, got ${a1}`);
  assert.equal(choosePlanningRasterDpi(240, { widthPoints: 3370.39, heightPoints: 2383.94 }), 120);
});

test("adaptive raster falls back below 240 DPI when page size metadata is unavailable", () => {
  assert.equal(choosePlanningRasterDpi(240, null), 180);
  assert.equal(choosePlanningRasterDpi(150, null), 150);
});
