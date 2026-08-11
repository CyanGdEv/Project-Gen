import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hydrateDiscoveredPlanningDrawings,
  selectDiscoveredPlanningDrawings
} from "../src/planning/discovered-attachment-hydrate.mjs";

function attachment(overrides = {}) {
  return {
    imageName: "200001",
    title: "Proposed Roller Coaster Track Layout",
    classification: "ride-layout",
    priority: 220,
    narrative: false,
    drawing: true,
    proposed: true,
    rideLayout: true,
    url: "https://planning.example/portal/servlets/AttachmentShowServlet?ImageName=200001",
    transportUrl: "http://planning.example/portal/servlets/AttachmentShowServlet?ImageName=200001",
    tlsVerification: "legacy-http-official-host",
    ...overrides
  };
}

test("discovered drawing selection prefers ride/proposed geometry and excludes reports", () => {
  const selected = selectDiscoveredPlanningDrawings({ attachments: [
    attachment({ imageName: "3", title: "Existing Site Plan", classification: "site-plan", priority: 75, proposed: false, existing: true, rideLayout: false }),
    attachment({ imageName: "2", title: "Design and Access Statement", priority: -150, drawing: false, narrative: true, proposed: false, rideLayout: false }),
    attachment({ imageName: "1" }),
    attachment({ imageName: "4", title: "Proposed General Arrangement", classification: "general-arrangement", priority: 165, rideLayout: false })
  ]}, { maxDocuments: 3 });
  assert.deepEqual(selected.map((item) => item.imageName), ["1", "4", "3"]);
});

test("newly discovered official drawing is content-addressed after bounded verified download", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-discovered-"));
  try {
    const bytes = Buffer.from("%PDF-1.4\nproposed coaster track layout\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const seen = [];
    const result = await hydrateDiscoveredPlanningDrawings({
      applicationUrl: "https://planning.example/application/1",
      attachments: [attachment()]
    }, root, {
      applicationReference: "SMD/2016/0315",
      applicationStatus: "approved",
      allowLegacyHttpTransport: true,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": String(bytes.length) }
        });
      }
    });

    assert.equal(result.documents.length, 1);
    assert.equal(result.rideLayoutDocuments, 1);
    assert.equal(result.proposedDocuments, 1);
    assert.equal(result.documents[0].sha256, sha256);
    assert.equal(result.documents[0].bytes, bytes.length);
    assert.equal(result.documents[0].applicationReference, "SMD/2016/0315");
    assert.equal(result.documents[0].applicationStatus, "approved");
    assert.equal(result.documents[0].file, `files/${sha256}.pdf`);
    assert.deepEqual(await readFile(path.join(root, result.documents[0].file)), bytes);
    assert.match(seen[0], /^http:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovered hydration rejects off-host redirects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-discovered-redirect-"));
  try {
    const bytes = Buffer.from("%PDF-1.4\nunsafe\n");
    await assert.rejects(
      hydrateDiscoveredPlanningDrawings({ applicationUrl: "https://planning.example/application/1", attachments: [attachment()] }, root, {
        fetchImpl: async () => {
          const response = new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
          Object.defineProperty(response, "url", { value: "https://evil.example/stolen.pdf" });
          return response;
        }
      }),
      /redirected off official host/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
