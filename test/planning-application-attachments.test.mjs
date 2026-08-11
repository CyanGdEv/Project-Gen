import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverPlanningApplicationAttachments,
  discoverPlanningDocumentNavigation,
  parsePlanningApplicationAttachments,
  rankPlanningAttachment
} from "../src/planning/application-attachments.mjs";

const APPLICATION_URL = "https://publicaccess.example/portal/servlets/ApplicationSearchServlet?PKID=104356";

const HTML = `
<table>
<tr><td>Plans</td><td>Proposed Roller Coaster Track Layout</td><td><a href="/portal/servlets/AttachmentShowServlet?ImageName=200001">View</a></td></tr>
<tr><td>Plans</td><td>Existing Site Plan</td><td><a href="/portal/servlets/AttachmentShowServlet?ImageName=200002">View</a></td></tr>
<tr><td>Supporting</td><td>Design and Access Statement - New Ride</td><td><a href="/portal/servlets/AttachmentShowServlet?ImageName=200003">View</a></td></tr>
<tr><td>Supporting</td><td>Landscape and Visual Impact Assessment - New Ride Part 1</td><td><a href="/portal/servlets/AttachmentShowServlet?ImageName=200004">View</a></td></tr>
<tr><td>Plans</td><td>Proposed General Arrangement</td><td><a href="/portal/servlets/AttachmentShowServlet?ImageName=200005">View</a></td></tr>
</table>`;

test("planning attachment parser ranks proposed ride drawings before existing plans and reports", () => {
  const attachments = parsePlanningApplicationAttachments(HTML, { applicationUrl: APPLICATION_URL });
  assert.equal(attachments.length, 5);
  assert.equal(attachments[0].imageName, "200001");
  assert.equal(attachments[0].classification, "ride-layout");
  assert.equal(attachments[0].rideLayout, true);
  assert.equal(attachments[0].proposed, true);
  assert.equal(attachments[0].narrative, false);
  assert.equal(attachments[1].imageName, "200005");
  const existing = attachments.find((item) => item.imageName === "200002");
  assert.equal(existing.existing, true);
  assert.ok(existing.priority < attachments[1].priority);
  for (const imageName of ["200003", "200004"]) {
    const report = attachments.find((item) => item.imageName === imageName);
    assert.equal(report.narrative, true);
    assert.ok(report.priority <= -150);
    assert.equal(report.rideLayout, false);
  }
});

test("planning attachment parser discovers JavaScript AttachmentShowServlet references", () => {
  const html = `
    <table><tr><td>Proposed Roller Coaster Track Layout</td><td>
      <button onclick="window.open('/portal/servlets/AttachmentShowServlet?ImageName=201111&amp;foo=1')">View drawing</button>
    </td></tr></table>`;
  const attachments = parsePlanningApplicationAttachments(html, { applicationUrl: APPLICATION_URL });
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].imageName, "201111");
  assert.equal(attachments[0].rideLayout, true);
  assert.equal(attachments[0].proposed, true);
});

test("ride wording without drawing cues does not become ride-layout evidence", () => {
  const ranked = rankPlanningAttachment({ title: "Design and Access Statement - New Ride" });
  assert.equal(ranked.narrative, true);
  assert.equal(ranked.rideLayout, false);
  assert.equal(ranked.drawing, false);
});

test("document navigation stays on the planning host and follows documents/plans links", () => {
  const html = `
    <a href="/portal/servlets/ApplicationDocumentsServlet?PKID=104356">Associated Documents and Plans</a>
    <a href="https://evil.example/documents">Documents</a>
    <a href="/help">Help</a>`;
  const links = discoverPlanningDocumentNavigation(html, APPLICATION_URL);
  assert.equal(links.length, 1);
  assert.match(links[0].url, /^https:\/\/publicaccess\.example\//);
  assert.match(links[0].text, /Associated Documents/);
});

test("attachment discovery follows a same-host document subpage when the application page has no direct attachments", async () => {
  const seen = [];
  const applicationHtml = `<h1>Planning Application</h1><a href="/portal/servlets/ApplicationDocumentsServlet?PKID=104356">Associated Documents</a>`;
  const documentHtml = `<table><tr><td>Proposed Roller Coaster Track Layout</td><td><script>open('/portal/servlets/AttachmentShowServlet?ImageName=202222')</script></td></tr></table>`;
  const result = await discoverPlanningApplicationAttachments(APPLICATION_URL, {
    allowLegacyHttpTransport: true,
    retries: 0,
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(String(url).includes("ApplicationDocumentsServlet") ? documentHtml : applicationHtml, { status: 200 });
    }
  });
  assert.equal(result.attachments.length, 1);
  assert.equal(result.rideLayoutAttachments[0].imageName, "202222");
  assert.equal(result.followed.length, 1);
  assert.ok(seen.some((url) => url.includes("ApplicationDocumentsServlet")));
});

test("attachment discovery supports the official legacy HTTP transport but returns HTTPS canonical URLs", async () => {
  const seen = [];
  const result = await discoverPlanningApplicationAttachments(APPLICATION_URL, {
    allowLegacyHttpTransport: true,
    retries: 0,
    fetchImpl: async (url) => {
      seen.push(String(url));
      assert.match(String(url), /^http:/);
      return new Response(HTML, { status: 200 });
    }
  });
  assert.equal(result.status, "usable");
  assert.equal(result.attachments.length, 5);
  assert.equal(result.rideLayoutAttachments.length, 1);
  assert.match(result.rideLayoutAttachments[0].url, /^https:/);
  assert.match(result.rideLayoutAttachments[0].transportUrl, /^http:/);
  assert.equal(seen.length, 1);
});
