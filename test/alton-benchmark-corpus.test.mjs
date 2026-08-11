import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAltonPlanningCorpus } from "../benchmark/normalize-alton-planning-corpus.mjs";

const oldSha = "09e78a0d62c5e568cd1b50b7f634c8f791a2116e8474674402e5e4c9fda0bec3";
const topoSha = "82cac12a14cd3d9d4232f409e681bd977f6c7f4f03be7b9049a6f845375543a9";

test("Alton benchmark replaces report-like drainage evidence with approved topographical geometry", () => {
  const manifest = {
    schemaVersion: 1,
    status: "usable",
    liveApplications: 2,
    documentsDownloaded: 2,
    totalBytes: 4010449,
    applications: [
      {
        reference: "SMD/2019/0695",
        status: "approved",
        downloadedDocuments: [{ url: "https://example/old", sha256: oldSha, bytes: 4010349 }]
      },
      {
        reference: "SMD/2021/0211",
        status: "approved",
        downloadedDocuments: [{ url: "https://example/existing", sha256: "a".repeat(64), bytes: 100 }]
      }
    ],
    entries: [
      { kind: "document", url: "https://example/old", file: `files/${oldSha}.pdf`, bytes: 4010349, sha256: oldSha, mime: "application/pdf" },
      { kind: "document", url: "https://example/existing", file: "files/existing.pdf", bytes: 100, sha256: "a".repeat(64), mime: "application/pdf" }
    ],
    warnings: []
  };

  const normalized = normalizeAltonPlanningCorpus(manifest);
  assert.equal(normalized.documentsDownloaded, 2);
  assert.equal(normalized.liveApplications, 1);
  assert.equal(normalized.entries.some((entry) => entry.sha256 === oldSha), false);
  assert.equal(normalized.entries.some((entry) => entry.sha256 === topoSha), true);
  assert.equal(normalized.applications[0].reference, "SMD/2021/0211");
  assert.equal(normalized.applications[0].downloadedDocuments.some((document) => document.sha256 === topoSha), true);
  assert.equal(normalized.totalBytes, 469357);
  assert.match(normalized.warnings.at(-1), /topographical survey/);
});
