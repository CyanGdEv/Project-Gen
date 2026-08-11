import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSemanticAnchorsFromTsv } from "./semantics.mjs";

const DEFAULT_REGISTER_TIMEOUT_MS = 25000;
const DEFAULT_TOOL_TIMEOUT_MS = 15000;
const DEFAULT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;

function safeToken(value) {
  return String(value || "unknown").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

async function sha256File(filename) {
  const data = await readFile(filename);
  return createHash("sha256").update(data).digest("hex");
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") throw new Error("rendered artifact is not a PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function documentPath(document) {
  const filename = document?.path || document?.file || document?.sourceFile;
  if (!filename) throw new Error(`planning document ${document?.id || document?.sha256 || "unknown"} has no local path`);
  return path.resolve(filename);
}

async function runTool(command, args, options = {}) {
  const timeoutMs = Math.max(100, Number(options.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS));
  const maxStdoutBytes = Math.max(1024, Number(options.maxStdoutBytes || DEFAULT_MAX_STDOUT_BYTES));
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${command} exceeded stdout limit ${maxStdoutBytes}`));
        }
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) return reject(new Error(`${command} failed code=${code} signal=${signal || "none"}: ${err.slice(-4000)}`));
      resolve({ stdout: out, stderr: err });
    });
    if (options.input !== undefined) child.stdin.end(typeof options.input === "string" ? options.input : JSON.stringify(options.input));
    else child.stdin.end();
  });
}

export function extractScaleDenominators(text, options = {}) {
  const min = Math.max(10, Number(options.min || 25));
  const max = Math.max(min, Number(options.max || 10000));
  const values = new Set();
  const source = String(text || "");
  for (const match of source.matchAll(/(?:scale\s*)?1\s*[:/]\s*([0-9]{2,5})\b/gi)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value >= min && value <= max) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export function createNativePlanningProcessors(options = {}) {
  const artifactRoot = path.resolve(options.artifactRoot || ".project-gen-cache/planning-artifacts");
  const referenceImagePath = options.referenceImagePath ? path.resolve(options.referenceImagePath) : null;
  const pdftoppm = options.pdftoppm || "pdftoppm";
  const tesseract = options.tesseract || "tesseract";
  const python = options.python || "python3";
  const registrationScript = path.resolve(options.registrationScript || fileURLToPath(new URL("./planning_auto_register.py", import.meta.url)));
  const toolTimeoutMs = Math.max(1000, Number(options.toolTimeoutMs || DEFAULT_TOOL_TIMEOUT_MS));
  const registerTimeoutMs = Math.max(toolTimeoutMs, Number(options.registerTimeoutMs || DEFAULT_REGISTER_TIMEOUT_MS));
  const semanticMinConfidence = Number(options.semanticMinConfidence ?? 35);

  async function renderPage({ document, page, dpi }) {
    const source = documentPath(document);
    const mime = String(document?.mime || "").toLowerCase();
    const key = `${safeToken(document.sha256 || document.id)}-p${Number(page)}-${Number(dpi)}`;
    const directory = path.join(artifactRoot, "renders");
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${key}.png`);

    if (mime === "application/pdf" || source.toLowerCase().endsWith(".pdf")) {
      const base = target.slice(0, -4);
      await runTool(pdftoppm, ["-f", String(page), "-l", String(page), "-singlefile", "-png", "-r", String(dpi), source, base], { timeoutMs: toolTimeoutMs });
    } else {
      if (Number(page) !== 1) throw new Error(`image planning document only supports page 1: ${source}`);
      await copyFile(source, target);
    }

    const data = await readFile(target);
    const dimensions = pngDimensions(data);
    const info = await stat(target);
    return {
      path: target,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: info.size,
      width: dimensions.width,
      height: dimensions.height,
      dpi: Number(dpi),
      renderer: mime === "application/pdf" || source.toLowerCase().endsWith(".pdf") ? "pdftoppm" : "image-copy"
    };
  }

  async function validateRenderArtifact(render) {
    if (!render?.path || !render?.sha256) return false;
    try {
      const info = await stat(render.path);
      return info.isFile() && (!render.bytes || info.size === Number(render.bytes));
    } catch {
      return false;
    }
  }

  async function extractSemantics({ render }) {
    const { stdout } = await runTool(tesseract, [render.path, "stdout", "--dpi", String(render.dpi || 240), "tsv"], {
      timeoutMs: toolTimeoutMs,
      maxStdoutBytes: 16 * 1024 * 1024
    });
    const parsed = extractSemanticAnchorsFromTsv(stdout, { minConfidence: semanticMinConfidence });
    return { ...parsed, engine: "tesseract-tsv", tsvSha256: createHash("sha256").update(stdout).digest("hex") };
  }

  async function registerPage({ document, render, semantics, bbox }) {
    if (!referenceImagePath) throw new Error("native planning registration requires referenceImagePath");
    await access(referenceImagePath);
    const request = {
      imagePath: render.path,
      referenceImagePath,
      imageDpi: render.dpi || 240,
      bbox,
      locationPrior: document?.locationPrior || null,
      scaleDenominators: extractScaleDenominators(semantics?.text),
      angles: options.registrationAngles || undefined,
      minConfidence: Number(options.minRegistrationConfidence ?? 0.72)
    };
    const { stdout } = await runTool(python, [registrationScript, "register"], { input: request, timeoutMs: registerTimeoutMs });
    const result = JSON.parse(stdout);
    return { ...result, worker: "opencv-roi-v1" };
  }

  async function vectorizePage({ render, semantics, candidate, bbox }) {
    const request = {
      imagePath: render.path,
      referenceImagePath,
      bbox,
      candidate,
      semantics,
      semanticDistancePx: Number(options.semanticDistancePx ?? 120)
    };
    const { stdout } = await runTool(python, [registrationScript, "vectorize"], { input: request, timeoutMs: registerTimeoutMs });
    const result = JSON.parse(stdout);
    return { ...result, worker: "opencv-semantic-vector-v1" };
  }

  return {
    renderPage,
    validateRenderArtifact,
    extractSemantics,
    registerPage,
    vectorizePage,
    metadata: {
      artifactRoot,
      referenceImagePath,
      registrationScript,
      tools: { pdftoppm, tesseract, python }
    }
  };
}

export async function nativePlanningWorkerSelfTest(options = {}) {
  const python = options.python || "python3";
  const registrationScript = path.resolve(options.registrationScript || fileURLToPath(new URL("./planning_auto_register.py", import.meta.url)));
  const { stdout } = await runTool(python, [registrationScript, "self-test"], { timeoutMs: Number(options.timeoutMs || 15000) });
  const result = JSON.parse(stdout);
  if (result.status !== "ok" || Number(result.f1 || 0) < 0.70) throw new Error(`native registration self-test failed: ${stdout}`);
  return result;
}

export { runTool, sha256File };
