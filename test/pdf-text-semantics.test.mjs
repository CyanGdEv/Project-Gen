import test from "node:test";
import assert from "node:assert/strict";
import { createPdfTextSemanticExtractor, extractSemanticAnchorsFromPdfBbox } from "../src/planning/pdf-text-semantics.mjs";

const XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<doc>
  <page width="1000" height="500">
    <flow><block>
      <line xMin="100" yMin="50" xMax="400" yMax="80">
        <word xMin="100" yMin="50" xMax="180" yMax="80">Raised</word>
        <word xMin="190" yMin="50" xMax="300" yMax="80">Footbridge</word>
      </line>
      <line xMin="100" yMin="100" xMax="400" yMax="130">
        <word xMin="100" yMin="100" xMax="170" yMax="130">Scale</word>
        <word xMin="180" yMin="100" xMax="260" yMax="130">1:500</word>
      </line>
    </block></flow>
  </page>
</doc>`;

test("embedded PDF bbox text is scaled into raster pixels and classified semantically", () => {
  const result = extractSemanticAnchorsFromPdfBbox(XHTML, { width: 2000, height: 1000 });
  assert.equal(result.wordCount, 4);
  assert.equal(result.lines.length, 2);
  assert.equal(result.anchors.length, 1);
  assert.equal(result.anchors[0].role, "site-path-centerline-candidate");
  assert.equal(result.anchors[0].bounds.left, 200);
  assert.equal(result.anchors[0].bounds.top, 100);
  assert.equal(result.anchors[0].bounds.width, 400);
  assert.match(result.text, /Scale 1:500/);
});

test("PDF semantic extractor uses embedded text and avoids OCR fallback when text is usable", async () => {
  let fallbackCalls = 0;
  const extractor = createPdfTextSemanticExtractor({
    minCharacters: 8,
    runTool: async (command, args) => {
      assert.equal(command, "pdftotext");
      assert.deepEqual(args.slice(0, 4), ["-f", "2", "-l", "2"]);
      return { stdout: XHTML, stderr: "" };
    }
  });
  const result = await extractor({
    document: { mime: "application/pdf", path: "/tmp/plan.pdf" },
    page: 2,
    render: { width: 2000, height: 1000 }
  }, async () => {
    fallbackCalls += 1;
    return { engine: "fallback" };
  });
  assert.equal(result.engine, "pdftotext-bbox-v1");
  assert.equal(result.embeddedText, true);
  assert.equal(fallbackCalls, 0);
});

test("PDF semantic extractor falls back to OCR for image-only or sparse PDF text", async () => {
  let fallbackCalls = 0;
  const extractor = createPdfTextSemanticExtractor({
    minCharacters: 24,
    runTool: async () => ({ stdout: `<doc><page width="1000" height="500"><line><word xMin="1" yMin="1" xMax="10" yMax="10">A</word></line></page></doc>`, stderr: "" })
  });
  const result = await extractor({
    document: { mime: "application/pdf", path: "/tmp/scan.pdf" },
    page: 1,
    render: { width: 1000, height: 500 }
  }, async () => {
    fallbackCalls += 1;
    return { engine: "tesseract-tsv", text: "OCR fallback" };
  });
  assert.equal(result.engine, "tesseract-tsv");
  assert.equal(fallbackCalls, 1);
});
