import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSemanticAnchorsFromTsv } from "./semantics.mjs";

const DEFAULT_REGISTER_TIMEOUT_MS = 25000;
const DEFAULT_TOOL_TIMEOUT_MS = 15000;
const DEFAULT_RENDER_TIMEOUT_MS = 30000;
const DEFAULT_SEMANTIC_TIMEOUT_MS = 20000;
const DEFAULT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RASTER_LONG_EDGE_PX = 5200;
const DEFAULT_MIN_RASTER_DPI = 120;
const DEFAULT_FALLBACK_RASTER_DPI = 180;

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

function terminateProcessTree(child, signal = "SIGKILL") {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to killing the direct child when the process group has already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited; timeout/error handling remains deterministic.
  }
}

async function runTool(command, args, options = {}) {
  const timeoutMs = Math.max(100, Number(options.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS));
  const maxStdoutBytes = Math.max(1024, Number(options.maxStdoutBytes || DEFAULT_MAX_STDOUT_BYTES));
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;

    function rejectAndTerminate(error) {
      if (settled) return;
      settled = true;
      terminateProcessTree(child);
      clearTimeout(timer);
      reject(error);
    }

    const timer = setTimeout(() => {
      const error = new Error(`${command} timed out after ${timeoutMs}ms`);
      error.code = "PLANNING_TOOL_TIMEOUT";
      error.recoverablePlanningPage = true;
      rejectAndTerminate(error);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        const error = new Error(`${command} exceeded stdout limit ${maxStdoutBytes}`);
        error.code = "PLANNING_TOOL_OUTPUT_LIMIT";
        error.recoverablePlanningPage = true;
        rejectAndTerminate(error);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => rejectAndTerminate(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        const error = new Error(`${command} failed code=${code} signal=${signal || "none"}: ${err.slice(-4000)}`);
        error.code = "PLANNING_TOOL_FAILED";
        error.recoverablePlanningPage = true;
        return reject(error);
      }
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

export function parsePdfPageSize(text, page = null) {
  const source = String(text || "");
  const pagePattern = page == null ? null : new RegExp(`^Page\\s+${Number(page)}\\s+size:\\s*([0-9.]+)\\s+x\\s+([0-9.]+)\\s+pts`, "mi");
  const match = (pagePattern ? source.match(pagePattern) : null)
    || source.match(/^Page\s+size:\s*([0-9.]+)\s+x\s+([0-9.]+)\s+pts/mi)
    || source.match(/^Page\s+\d+\s+size:\s*([0-9.]+)\s+x\s+([0-9.]+)\s+pts/mi);
  if (!match) return null;
  const widthPoints = Number(match[1]);
  const heightPoints = Number(match[2]);
  if (![widthPoints, heightPoints].every((value) => Number.isFinite(value) && value > 0)) return null;
  return { widthPoints, heightPoints };
}

export function choosePlanningRasterDpi(requestedDpi, pageSize = null, options = {}) {
  const requested = Math.max(72, Math.min(600, Number(requestedDpi || 240)));
  const maxLongEdgePx = Math.max(1800, Number(options.maxLongEdgePx || DEFAULT_MAX_RASTER_LONG_EDGE_PX));
  const minDpi = Math.max(72, Math.min(requested, Number(options.minDpi || DEFAULT_MIN_RASTER_DPI)));
  const fallbackDpi = Math.max(minDpi, Math.min(requested, Number(options.fallbackDpi || DEFAULT_FALLBACK_RASTER_DPI)));
  const longestPoints = Math.max(Number(pageSize?.widthPoints || 0), Number(pageSize?.heightPoints || 0));
  if (!Number.isFinite(longestPoints) || longestPoints <= 0) return Math.round(fallbackDpi);
  const pixelBoundDpi = Math.floor((maxLongEdgePx * 72) / longestPoints);
  return Math.round(Math.max(minDpi, Math.min(requested, pixelBoundDpi)));
}

export function scalePlanningPixelThreshold(basePixels, render, options = {}) {
  const base = Math.max(0, Number(basePixels || 0));
  const requestedDpi = Math.max(1, Number(render?.requestedDpi || render?.dpi || 240));
  const effectiveDpi = Math.max(1, Number(render?.dpi || requestedDpi));
  const scale = Math.min(1, effectiveDpi / requestedDpi);
  const minimum = Math.max(0, Number(options.minimum ?? 1));
  return Math.max(minimum, base * scale);
}

export function createNativePlanningProcessors(options = {}) {
  const artifactRoot = path.resolve(options.artifactRoot || ".project-gen-cache/planning-artifacts");
  const referenceImagePath = options.referenceImagePath ? path.resolve(options.referenceImagePath) : null;
  const pdftoppm = options.pdftoppm || "pdftoppm";
  const pdfinfo = options.pdfinfo || "pdfinfo";
  const tesseract = options.tesseract || "tesseract";
  const python = options.python || "python3";
  const registrationScript = path.resolve(options.registrationScript || fileURLToPath(new URL("./planning_auto_register.py", import.meta.url)));
  const toolTimeoutMs = Math.max(1000, Number(options.toolTimeoutMs || DEFAULT_TOOL_TIMEOUT_MS));
  const renderTimeoutMs = Math.max(toolTimeoutMs, Number(options.renderTimeoutMs || DEFAULT_RENDER_TIMEOUT_MS));
  const semanticTimeoutMs = Math.max(toolTimeoutMs, Number(options.semanticTimeoutMs || DEFAULT_SEMANTIC_TIMEOUT_MS));
  const preflightTimeoutMs = Math.max(1000, Math.min(renderTimeoutMs, Number(options.preflightTimeoutMs || 5000)));
  const registerTimeoutMs = Math.max(toolTimeoutMs, Number(options.registerTimeoutMs || DEFAULT_REGISTER_TIMEOUT_MS));
  const semanticMinConfidence = Number(options.semanticMinConfidence ?? 35);

  async function renderPage({ document, page, dpi }) {
    const source = documentPath(document);
    const mime = String(document?.mime || "").toLowerCase();
    const documentId = safeToken(document.sha256 || document.id);
    const requestedDpi = Number(dpi || 240);
    let effectiveDpi = requestedDpi;
    let pageSize = null;

    if (mime === "application/pdf" || source.toLowerCase().endsWith(".pdf")) {
      try {
        const { stdout } = await runTool(pdfinfo, ["-f", String(page), "-l", String(page), source], {
          timeoutMs: preflightTimeoutMs,
          maxStdoutBytes: 1024 * 1024
        });
        pageSize = parsePdfPageSize(stdout, page);
      } catch (error) {
        if (!error?.recoverablePlanningPage) throw error;
      }
      effectiveDpi = choosePlanningRasterDpi(requestedDpi, pageSize, {
        maxLongEdgePx: options.maxRasterLongEdgePx,
        minDpi: options.minRasterDpi,
        fallbackDpi: options.fallbackRasterDpi
      });
    }

    const key = `${documentId}-p${Number(page)}-${requestedDpi}r${effectiveDpi}`;
    const directory = path.join(artifactRoot, "renders");
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${key}.png`);

    if (mime === "application/pdf" || source.toLowerCase().endsWith(".pdf")) {
      const base = target.slice(0, -4);
      try {
        await runTool(pdftoppm, [
          "-f", String(page), "-l", String(page), "-singlefile", "-gray", "-png",
          "-r", String(effectiveDpi), source, base
        ], { timeoutMs: renderTimeoutMs });
      } catch (error) {
        const wrapped = new Error(`planning raster failed document=${documentId} page=${Number(page)} requestedDpi=${requestedDpi} effectiveDpi=${effectiveDpi}: ${error.message}`, { cause: error });
        wrapped.code = error?.code;
        wrapped.recoverablePlanningPage = Boolean(error?.recoverablePlanningPage);
        throw wrapped;
      }
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
      dpi: Number(effectiveDpi),
      requestedDpi,
      adaptiveRaster: Number(effectiveDpi) < requestedDpi,
      pageSizePoints: pageSize,
      renderer: mime === "application/pdf" || source.toLowerCase().endsWith(".pdf") ? "pdftoppm-gray-adaptive-v1" : "image-copy"
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

  async function extractSemantics({ document, page, render }) {
    let stdout;
    try {
      ({ stdout } = await runTool(tesseract, [render.path, "stdout", "--dpi", String(render.dpi || 240), "tsv"], {
        timeoutMs: semanticTimeoutMs,
        maxStdoutBytes: 16 * 1024 * 1024
      }));
    } catch (error) {
      const wrapped = new Error(`planning OCR failed document=${safeToken(document?.sha256 || document?.id)} page=${Number(page)}: ${error.message}`, { cause: error });
      wrapped.code = error?.code;
      wrapped.recoverablePlanningPage = Boolean(error?.recoverablePlanningPage);
      throw wrapped;
    }
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
      semanticDistancePx: scalePlanningPixelThreshold(Number(options.semanticDistancePx ?? 120), render, { minimum: 24 })
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
      timeouts: { toolTimeoutMs, renderTimeoutMs, semanticTimeoutMs, registerTimeoutMs },
      raster: {
        maxLongEdgePx: Number(options.maxRasterLongEdgePx || DEFAULT_MAX_RASTER_LONG_EDGE_PX),
        minDpi: Number(options.minRasterDpi || DEFAULT_MIN_RASTER_DPI),
        fallbackDpi: Number(options.fallbackRasterDpi || DEFAULT_FALLBACK_RASTER_DPI)
      },
      tools: { pdftoppm, pdfinfo, tesseract, python }
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

export { runTool, sha256File, terminateProcessTree };
