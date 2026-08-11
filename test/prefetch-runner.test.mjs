import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preparePrefetchDocuments } from "../src/planning/prefetch-runner.mjs";

test("planning prefetch documents are bridged to local paths, pages and georeference metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-prefetch-bridge-"));
  try {
    await mkdir(path.join(root, "files"), { recursive: true });
    await writeFile(path.join(root, "files/plan.png"), Buffer.from("fixture"));
    const url = "https://planning.example.gov/plan";
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      status: "usable",
      applications: [{
        reference: "APP/42",
        longitude: -1.88,
        latitude: 52.99,
        downloadedDocuments: [{
          url,
          explicitControlPoints: [
            { x: 0, y: 0, longitude: -1.89, latitude: 52.995 },
            { x: 100, y: 0, longitude: -1.87, latitude: 52.995 },
            { x: 0, y: 100, longitude: -1.89, latitude: 52.98 }
          ]
        }]
      }],
      entries: []
    }));
    const ingestion = {
      documents: [{
        id: "planning:abc",
        sha256: "abc",
        mime: "image/png",
        file: "files/plan.png",
        url,
        applicationReference: "APP/42",
        narrative: false,
        priority: 130
      }]
    };
    const [document] = await preparePrefetchDocuments(root, ingestion);
    assert.equal(document.path, path.join(root, "files/plan.png"));
    assert.deepEqual(document.pages, [1]);
    assert.deepEqual(document.locationPrior, { longitude: -1.88, latitude: 52.99 });
    assert.equal(document.explicitControlPoints.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
