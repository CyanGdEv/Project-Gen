import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentKey } from "../cache.mjs";
import { runTool, sha256File } from "./native-workers.mjs";

export const PLANNING_REFERENCE_VERSION = 1;

function payloadHash(source) {
  const provided = source?.provenance?.contentSha256;
  if (/^[a-f0-9]{64}$/i.test(String(provided || ""))) return String(provided).toLowerCase();
  return createHash("sha256").update(JSON.stringify(source?.payload || source || {})).digest("hex");
}

async function artifactValid(value) {
  try {
    const info = await stat(value?.path || "");
    return info.isFile() && (!value.bytes || info.size === Number(value.bytes));
  } catch {
    return false;
  }
}

export async function buildPlanningReference({ source, bbox, cache = null, options = {} }) {
  if (!source?.payload) throw new Error("planning registration reference requires source.payload");
  const size = Math.max(256, Math.min(4096, Number(options.size || 1600)));
  const sourceHash = payloadHash(source);
  const key = contentKey("planning-reference", { version: PLANNING_REFERENCE_VERSION, sourceHash, bbox, size });
  const cached = cache ? await cache.get(key) : null;
  if (cached && await artifactValid(cached)) return { ...cached, cacheHit: true };

  const root = path.resolve(options.artifactRoot || ".project-gen-cache/planning-artifacts/references");
  await mkdir(root, { recursive: true });
  const outputPath = path.join(root, `${key}.png`);
  const python = options.python || "python3";
  const script = path.resolve(options.script || fileURLToPath(new URL("./planning_reference.py", import.meta.url)));
  const { stdout } = await runTool(python, [script], {
    input: { payload: source.payload, bbox, size, outputPath },
    timeoutMs: Number(options.timeoutMs || 15000),
    maxStdoutBytes: 1024 * 1024
  });
  const report = JSON.parse(stdout);
  if (report.status !== "ok") throw new Error(`planning reference worker failed: ${stdout}`);
  const info = await stat(outputPath);
  const result = {
    path: outputPath,
    sha256: await sha256File(outputPath),
    bytes: info.size,
    width: Number(report.width),
    height: Number(report.height),
    sourceHash,
    source: source.source || "osm",
    role: "registration-context-only",
    features: Number(report.features || 0),
    segments: Number(report.segments || 0),
    cacheHit: false
  };
  if (cache) await cache.put(key, result);
  return result;
}
