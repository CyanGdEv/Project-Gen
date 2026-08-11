#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { bridgePlanningForPinnedVme } from "../src/world/vme-planning-bridge.mjs";

function parseArgs(argv) {
  const options = { input: null, output: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--input") options.input = argv[++index];
    else if (name === "--output") options.output = argv[++index];
    else if (name === "--report") options.report = argv[++index];
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.input) throw new Error("--input is required");
  if (!options.output) throw new Error("--output is required");
  if (!options.report) throw new Error("--report is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  const reportPath = path.resolve(options.report);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const result = bridgePlanningForPinnedVme(input);
  await Promise.all([
    mkdir(path.dirname(outputPath), { recursive: true }),
    mkdir(path.dirname(reportPath), { recursive: true })
  ]);
  await Promise.all([
    writeFile(outputPath, JSON.stringify(result.featureCollection)),
    writeFile(reportPath, `${JSON.stringify(result.report, null, 2)}\n`)
  ]);
  console.log(JSON.stringify({
    status: "complete",
    inputFeatures: result.report.inputFeatures,
    outputFeatures: result.report.outputFeatures,
    withheldFeatures: result.report.withheldFeatures,
    withheldByClass: result.report.withheldByClass,
    compiler: result.report.compiler,
    output: outputPath,
    report: reportPath
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 2;
});
