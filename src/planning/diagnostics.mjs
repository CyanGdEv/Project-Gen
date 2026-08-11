function increment(target, key) {
  const name = String(key ?? "unknown");
  target[name] = Number(target[name] || 0) + 1;
}

export function summarizePlanningEvidenceDiagnostics(documents = []) {
  const semanticEngines = {};
  const effectiveDpi = {};
  const rendererEngines = {};
  const failureStages = {};
  let pages = 0;
  let completedPages = 0;
  let adaptiveRasterPages = 0;
  let embeddedTextPages = 0;
  let ocrPages = 0;
  let failedPages = 0;

  for (const document of documents || []) {
    for (const page of document?.pages || []) {
      pages += 1;
      if (page?.error) {
        failedPages += 1;
        increment(failureStages, page.error.stage || "unknown");
        continue;
      }
      completedPages += 1;
      const render = page?.render || {};
      const semantics = page?.semantics || {};
      if (render.adaptiveRaster) adaptiveRasterPages += 1;
      if (Number.isFinite(Number(render.dpi))) increment(effectiveDpi, Math.round(Number(render.dpi)));
      increment(rendererEngines, render.renderer || "unknown");
      increment(semanticEngines, semantics.engine || "unknown");
      if (semantics.embeddedText || String(semantics.engine || "").startsWith("pdftotext-")) embeddedTextPages += 1;
      if (String(semantics.engine || "").startsWith("tesseract")) ocrPages += 1;
    }
  }

  return {
    pages,
    completedPages,
    failedPages,
    adaptiveRasterPages,
    embeddedTextPages,
    ocrPages,
    semanticEngines,
    rendererEngines,
    effectiveDpi,
    failureStages
  };
}
