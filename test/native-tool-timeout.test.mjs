import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNativePlanningProcessors, runTool } from "../src/planning/native-workers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("timed-out native tools terminate descendant processes", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-tool-timeout-"));
  const marker = path.join(root, "orphan-survived.txt");
  try {
    await assert.rejects(
      runTool("sh", ["-c", "sleep 0.6; printf survived > \"$MARKER\""], {
        timeoutMs: 100,
        env: { MARKER: marker }
      }),
      /timed out after 100ms/
    );
    await sleep(800);
    await assert.rejects(access(marker), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning workers expose independent raster, OCR, PDF-text and registration budgets", () => {
  const processors = createNativePlanningProcessors({
    toolTimeoutMs: 1000,
    renderTimeoutMs: 3200,
    semanticTimeoutMs: 2100,
    semanticTextTimeoutMs: 750,
    registerTimeoutMs: 4300
  });
  assert.deepEqual(processors.metadata.timeouts, {
    toolTimeoutMs: 1000,
    renderTimeoutMs: 3200,
    semanticTimeoutMs: 2100,
    semanticTextTimeoutMs: 750,
    registerTimeoutMs: 4300
  });
});
