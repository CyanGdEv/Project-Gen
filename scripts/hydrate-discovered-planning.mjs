#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { hydrateDiscoveredPlanningDrawings } from "../src/planning/discovered-attachment-hydrate.mjs";

function parseArgs(argv) {
  const options = {
    discovery: null,
    outputDirectory: null,
    applicationReference: null,
    applicationStatus: null,
    maxDocuments: 12,
    allowLegacyHttpTransport: false,
    timeoutMs: 45000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--discovery") options.discovery = argv[++index];
    else if (name === "--output-dir") options.outputDirectory = argv[++index];
    else if (name === "--application-reference") options.applicationReference = argv[++index];
    else if (name === "--application-status") options.applicationStatus = argv[++index];
    else if (name === "--max-documents") options.maxDocuments = Number(argv[++index]);
    else if (name === "--allow-legacy-http") options.allowLegacyHttpTransport = true;
    else if (name === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.discovery) throw new Error("--discovery is required");
  if (!options.outputDirectory) throw new Error("--output-dir is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const discovery = JSON.parse(await readFile(path.resolve(options.discovery), "utf8"));
  const result = await hydrateDiscoveredPlanningDrawings(discovery, path.resolve(options.outputDirectory), options);
  console.log(JSON.stringify({
    status: result.status,
    documents: result.documents.length,
    rideLayoutDocuments: result.rideLayoutDocuments,
    proposedDocuments: result.proposedDocuments,
    totalBytes: result.totalBytes,
    outputDirectory: path.resolve(options.outputDirectory),
    evidence: result.documents.map((item) => ({
      imageName: item.imageName,
      title: item.title,
      role: item.role,
      bytes: item.bytes,
      sha256: item.sha256,
      file: item.file
    }))
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 2;
});
