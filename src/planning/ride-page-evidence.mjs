const RIDE_CONTEXT = /\b(?:roller\s*coaster|coaster|ride|track|lift\s+hill|station|launch|brake\s+run)\b/i;
const RIDE_DRAWING = /\b(?:roller\s*coaster|coaster|ride|track)\b.*\b(?:plan|layout|general\s+arrangement|g\.?a\.?|drawing|profile)\b|\b(?:plan|layout|general\s+arrangement|g\.?a\.?|drawing|profile)\b.*\b(?:roller\s*coaster|coaster|ride|track)\b/i;
const DRAWING_CUES = /\b(?:scale\s*1\s*[:/]|drawing\s*(?:no|number)|revision|rev\.?\s*[a-z0-9]+|general\s+arrangement|g\.?a\.?|site\s+plan|block\s+plan|layout|plan\s+view|north\s+point|do\s+not\s+scale)\b/i;
const PROPOSED_CUE = /\b(?:proposed|new)\b/i;
const NARRATIVE_CUE = /\b(?:design\s*(?:and|&)\s*access\s+statement|landscape\s*(?:and|&)\s*visual\s+impact\s+assessment|lvia|chapter|contents|introduction|assessment|methodology|conclusion|appendix|report)\b/i;

function normalizedRole(document = {}) {
  return [document.role, document.documentRole, document.document_role, document.classification]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(" ");
}

function semanticLines(semantics = {}) {
  return Array.isArray(semantics.lines) ? semantics.lines.filter((line) => line?.text) : [];
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function bestRideAnchor(lines) {
  return lines
    .filter((line) => RIDE_DRAWING.test(String(line.text || "")))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || String(a.text).length - String(b.text).length)[0] || null;
}

export function classifyRideDrawingPage({ document = {}, semantics = {} } = {}) {
  const text = String(semantics.text || semanticLines(semantics).map((line) => line.text).join("\n"));
  const lines = semanticLines(semantics);
  const role = normalizedRole(document);
  const documentRidePrior = /ride-layout|ride\s+layout|coaster|track/.test(role);
  const rideDrawingCue = RIDE_DRAWING.test(text);
  const rideContextCue = RIDE_CONTEXT.test(text);
  const drawingCue = DRAWING_CUES.test(text);
  const proposedCue = PROPOSED_CUE.test(text);
  const narrativeCue = NARRATIVE_CUE.test(text);
  const words = wordCount(text);
  const denseProse = words >= 450 && !drawingCue;
  const anchor = bestRideAnchor(lines);

  let score = 0;
  if (documentRidePrior) score += 2;
  if (rideDrawingCue) score += 5;
  else if (rideContextCue) score += 1;
  if (drawingCue) score += 3;
  if (proposedCue) score += 1;
  if (anchor) score += 1;
  if (narrativeCue) score -= 4;
  if (denseProse) score -= 4;

  const eligible = Boolean(
    rideDrawingCue
    && drawingCue
    && score >= 7
    && !denseProse
  );

  return {
    eligible,
    score,
    documentRidePrior,
    rideDrawingCue,
    rideContextCue,
    drawingCue,
    proposedCue,
    narrativeCue,
    denseProse,
    wordCount: words,
    anchor: anchor ? {
      text: anchor.text,
      confidence: Number(anchor.confidence || 0),
      bounds: anchor.bounds || null
    } : null,
    reasons: [
      ...(documentRidePrior ? ["ride-document-prior"] : []),
      ...(rideDrawingCue ? ["ride-drawing-text"] : []),
      ...(drawingCue ? ["drawing-cues"] : []),
      ...(proposedCue ? ["proposed-cue"] : []),
      ...(narrativeCue ? ["narrative-cue"] : []),
      ...(denseProse ? ["dense-prose"] : [])
    ]
  };
}
