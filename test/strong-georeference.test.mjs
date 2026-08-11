import test from "node:test";
import assert from "node:assert/strict";
import { parseCoordinatePair, printedCoordinateControls, resolveStrongGeoreference } from "../src/planning/strong-georeference.mjs";

test("embedded geospatial metadata wins before explicit controls", async () => {
  let calls = 0;
  const result = await resolveStrongGeoreference({
    document: { mime: "application/pdf", path: "/tmp/a.pdf", explicitControlPoints: [
      { x: 0, y: 0, longitude: -1.88, latitude: 52.99 },
      { x: 100, y: 0, longitude: -1.87, latitude: 52.99 },
      { x: 0, y: 100, longitude: -1.88, latitude: 52.98 }
    ] },
    page: 1,
    render: { width: 1000, height: 800 },
    semantics: { lines: [] },
    bbox: [52.97, -1.90, 53.00, -1.85]
  }, {
    runTool: async (command) => {
      calls += 1;
      assert.equal(command, "gdalinfo");
      return { stdout: JSON.stringify({ wgs84Extent: { coordinates: [[[-1.89, 52.995], [-1.89, 52.975], [-1.86, 52.975], [-1.86, 52.995], [-1.89, 52.995]]] } }) };
    }
  });
  assert.equal(result.method, "embedded-geospatial");
  assert.equal(result.directAuthority, true);
  assert.equal(result.points[0].x, 0);
  assert.equal(result.points[1].y, 800);
  assert.equal(calls, 1);
});

test("explicit controls win when embedded metadata is absent", async () => {
  const result = await resolveStrongGeoreference({
    document: { mime: "application/pdf", path: "/tmp/a.pdf", explicitControlPoints: [
      { x: 0, y: 0, longitude: -1.88, latitude: 52.99 },
      { x: 100, y: 0, longitude: -1.87, latitude: 52.99 },
      { x: 0, y: 100, longitude: -1.88, latitude: 52.98 }
    ] },
    page: 1,
    render: { width: 100, height: 100 },
    semantics: { lines: [] },
    bbox: [52.97, -1.90, 53.00, -1.85]
  }, { runTool: async () => ({ stdout: JSON.stringify({}) }) });
  assert.equal(result.method, "explicit-control-points");
});

test("printed WGS84 coordinate pairs create direct controls", async () => {
  const semantics = { lines: [
    { text: "-1.889 52.990", bounds: { centerX: 100, centerY: 100 } },
    { text: "-1.879 52.990", bounds: { centerX: 900, centerY: 100 } },
    { text: "-1.889 52.980", bounds: { centerX: 100, centerY: 900 } }
  ] };
  const points = await printedCoordinateControls(semantics, [52.97, -1.90, 53.00, -1.85], async () => { throw new Error("not needed"); });
  assert.equal(points.length, 3);
  assert.deepEqual(parseCoordinatePair("E 403000 N 344000"), { type: "osgb", first: 403000, second: 344000 });
});
