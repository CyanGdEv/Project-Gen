import test from "node:test";
import assert from "node:assert/strict";
import { summarizePlanningEvidenceDiagnostics } from "../src/planning/diagnostics.mjs";

test("planning diagnostics distinguish embedded PDF text from OCR and adaptive raster pages", () => {
  const result = summarizePlanningEvidenceDiagnostics([
    {
      pages: [
        {
          render: { renderer: "pdftoppm-gray-adaptive-v1", dpi: 157, adaptiveRaster: true },
          semantics: { engine: "pdftotext-bbox-v1", embeddedText: true }
        },
        {
          render: { renderer: "pdftoppm-gray-adaptive-v1", dpi: 240, adaptiveRaster: false },
          semantics: { engine: "tesseract-tsv" }
        }
      ]
    },
    { pages: [{ error: { stage: "registration", code: "PLANNING_TOOL_TIMEOUT" } }] }
  ]);

  assert.equal(result.pages, 3);
  assert.equal(result.completedPages, 2);
  assert.equal(result.failedPages, 1);
  assert.equal(result.adaptiveRasterPages, 1);
  assert.equal(result.embeddedTextPages, 1);
  assert.equal(result.ocrPages, 1);
  assert.deepEqual(result.semanticEngines, { "pdftotext-bbox-v1": 1, "tesseract-tsv": 1 });
  assert.deepEqual(result.effectiveDpi, { "157": 1, "240": 1 });
  assert.deepEqual(result.failureStages, { registration: 1 });
});
