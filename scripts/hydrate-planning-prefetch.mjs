#!/usr/bin/env node
import process from "node:process";
import { hydratePlanningPrefetch } from "../src/planning/prefetch-hydrate.mjs";

function parseArgs(argv) {
  const options = {
    planningDirectory: null,
    concurrency: 4,
    timeoutMs: 45000,
    attemptTimeoutMs: 20000,
    retries: 3,
    retryDelayMs: 1000,
    allowLegacyHttpTransport: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--planning-dir") options.planningDirectory = argv[++index];
    else if (name === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (name === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (name === "--attempt-timeout-ms") options.attemptTimeoutMs = Number(argv[++index]);
    else if (name === "--retries") options.retries = Number(argv[++index]);
    else if (name === "--retry-delay-ms") options.retryDelayMs = Number(argv[++index]);
    else if (name === "--allow-legacy-http") options.allowLegacyHttpTransport = true;
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.planningDirectory) throw new Error("--planning-dir is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await hydratePlanningPrefetch(options.planningDirectory, options);
  console.log(JSON.stringify({
    status: result.status,
    documents: result.documents,
    downloaded: result.downloaded,
    reused: result.reused,
    bytesDownloaded: result.bytesDownloaded
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 2;
});
