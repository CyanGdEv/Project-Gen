import test from "node:test";
import assert from "node:assert/strict";
import { classifyRideDrawingPage } from "../src/planning/ride-page-evidence.mjs";

function line(text, confidence = 0.98, left = 100, top = 100) {
  return { text, confidence, bounds: { left, top, width: 400, height: 40, centerX: left + 200, centerY: top + 20 } };
}

test("proposed coaster track layout with scale/title-block cues enables ride extraction", () => {
  const semantics = {
    text: "PROPOSED ROLLER COASTER TRACK LAYOUT\nScale 1:500\nDrawing No AT-SW8-101\nRev B\nDo not scale",
    lines: [line("PROPOSED ROLLER COASTER TRACK LAYOUT"), line("Scale 1:500", 0.96, 100, 160)]
  };
  const result = classifyRideDrawingPage({ document: { role: "ride-layout" }, semantics });
  assert.equal(result.eligible, true);
  assert.ok(result.score >= 7);
  assert.equal(result.rideDrawingCue, true);
  assert.equal(result.drawingCue, true);
  assert.equal(result.anchor.text, "PROPOSED ROLLER COASTER TRACK LAYOUT");
});

test("ride-related Design and Access Statement page cannot enable track inference by document role alone", () => {
  const prose = Array.from({ length: 520 }, (_, index) => `word${index}`).join(" ");
  const semantics = {
    text: `Design and Access Statement - New Ride\nIntroduction\n${prose}`,
    lines: [line("Design and Access Statement - New Ride")]
  };
  const result = classifyRideDrawingPage({ document: { role: "ride-layout" }, semantics });
  assert.equal(result.documentRidePrior, true);
  assert.equal(result.eligible, false);
  assert.equal(result.denseProse, true);
  assert.equal(result.drawingCue, false);
});

test("generic proposed site plan does not become ride layout without ride-specific drawing wording", () => {
  const semantics = {
    text: "PROPOSED SITE PLAN\nScale 1:500\nDrawing No 102",
    lines: [line("PROPOSED SITE PLAN"), line("Scale 1:500")]
  };
  const result = classifyRideDrawingPage({ document: { role: "other" }, semantics });
  assert.equal(result.drawingCue, true);
  assert.equal(result.rideDrawingCue, false);
  assert.equal(result.eligible, false);
});

test("ride wording without drawing/title-block evidence stays ineligible", () => {
  const semantics = {
    text: "The proposed roller coaster ride will include a station and lift hill.",
    lines: [line("The proposed roller coaster ride will include a station and lift hill.")]
  };
  const result = classifyRideDrawingPage({ document: { role: "ride-layout" }, semantics });
  assert.equal(result.rideContextCue, true);
  assert.equal(result.rideDrawingCue, false);
  assert.equal(result.eligible, false);
});
