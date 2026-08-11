#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { discoverPlanningApplicationAttachments } from "../src/planning/application-attachments.mjs";

function parseArgs(argv) {
  const options = { applicationUrl: null, output: null, allowLegacyHttpTransport: false, retries: 3, timeoutMs: 30000 };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--application-url") options.applicationUrl = argv[++index];
    else if (name === "--output") options.output = argv[++index];
    else if (name === "--allow-legacy-http") options.allowLegacyHttpTransport = true;
    else if (name === "--retries") options.retries = Number(argv[++index]);
    else if (name === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.applicationUrl) throw new Error("--application-url is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await discoverPlanningApplicationAttachments(options.applicationUrl, options);
  if (options.output) {
    const filename = path.resolve(options.output);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({
    status: result.status,
    attachments: result.attachments.length,
    drawings: result.drawingAttachments.length,
    proposedDrawings: result.proposedDrawingAttachments.length,
    rideLayouts: result.rideLayoutAttachments.length,
    attempts: result.attempts,
    output: options.output ? path.resolve(options.output) : null
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 2;
});
