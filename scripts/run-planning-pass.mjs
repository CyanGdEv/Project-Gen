#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { FileArtifactCache } from "../src/cache.mjs";
import { runPlanningPrefetchFastPath } from "../src/planning/prefetch-runner.mjs";
import { createOsmOverpassAdapter } from "../src/sources/osm-overpass.mjs";

function parseArgs(argv) {
  const options = {
    planningDirectory: null,
    bbox: null,
    outputDirectory: "project-gen-planning-output",
    cacheRoot: ".project-gen-cache",
    overpass: process.env.PROJECT_GEN_OVERPASS_URL || "https://overpass-api.de/api/interpreter",
    maxProcessingDocuments: 500,
    maxPages: 12,
    concurrency: 4,
    dpi: 240
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--planning-dir") options.planningDirectory = argv[++index];
    else if (name === "--bbox") options.bbox = argv[++index].split(",").map(Number);
    else if (name === "--output") options.outputDirectory = argv[++index];
    else if (name === "--cache") options.cacheRoot = argv[++index];
    else if (name === "--overpass") options.overpass = argv[++index];
    else if (name === "--max-documents") options.maxProcessingDocuments = Number(argv[++index]);
    else if (name === "--max-pages") options.maxPages = Number(argv[++index]);
    else if (name === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (name === "--dpi") options.dpi = Number(argv[++index]);
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.planningDirectory) throw new Error("--planning-dir is required");
  if (!Array.isArray(options.bbox) || options.bbox.length !== 4 || options.bbox.some((value) => !Number.isFinite(value))) {
    throw new Error("--bbox must be south,west,north,east");
  }
  return options;
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = nowMs();
  const cache = new FileArtifactCache(path.join(path.resolve(options.cacheRoot), "metadata"));

  const osmStarted = nowMs();
  const osm = createOsmOverpassAdapter({ endpoint: options.overpass, cache, freshForMs: 6 * 60 * 60 * 1000 });
  const osmSource = await osm.acquire({
    request: { bbox: options.bbox },
    cache,
    elapsedMs: 0,
    deadlineMs: 65000
  });
  const osmMs = nowMs() - osmStarted;

  const planningStarted = nowMs();
  const result = await runPlanningPrefetchFastPath({
    planningDirectory: options.planningDirectory,
    bbox: options.bbox,
    osmSource,
    cache,
    cacheRoot: path.resolve(options.cacheRoot),
    maxProcessingDocuments: options.maxProcessingDocuments,
    maxPages: options.maxPages,
    concurrency: options.concurrency,
    dpi: options.dpi,
    referenceOptions: {
      artifactRoot: path.join(path.resolve(options.cacheRoot), "planning-artifacts", "references")
    },
    artifactRoot: path.join(path.resolve(options.cacheRoot), "planning-artifacts")
  });
  const planningMs = nowMs() - planningStarted;
  const totalMs = nowMs() - startedAt;

  const output = path.resolve(options.outputDirectory);
  await mkdir(output, { recursive: true });
  const featureCollection = {
    type: "FeatureCollection",
    features: result.features
  };
  const report = {
    schemaVersion: 1,
    status: "complete",
    bbox: options.bbox,
    timings: { osmMs, planningMs, totalMs },
    fiveMinuteTargetMs: 300000,
    withinFiveMinuteTarget: totalMs <= 300000,
    planning: {
      processedDocuments: result.processedDocuments,
      acceptedDocuments: result.georeference.acceptedIds.length,
      directAcceptedDocuments: result.georeference.directAcceptedIds.length,
      consensusAcceptedDocuments: result.georeference.consensusAcceptedIds.length,
      features: result.features.length,
      metrics: result.metrics,
      ingestion: result.ingestion,
      reference: result.reference
    },
    osm: {
      cacheHit: osmSource.cacheHit,
      cacheMode: osmSource.cacheMode,
      contentSha256: osmSource.provenance?.contentSha256 || null,
      role: "registration-context-and-gap-fill-only"
    }
  };
  await Promise.all([
    writeFile(path.join(output, "planning-authority.geojson"), JSON.stringify(featureCollection)),
    writeFile(path.join(output, "planning-pass-report.json"), JSON.stringify(report, null, 2))
  ]);
  console.log(JSON.stringify({
    status: report.status,
    documents: report.planning.processedDocuments,
    accepted: report.planning.acceptedDocuments,
    features: report.planning.features,
    totalMs,
    withinFiveMinuteTarget: report.withinFiveMinuteTarget,
    output
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 2;
});
