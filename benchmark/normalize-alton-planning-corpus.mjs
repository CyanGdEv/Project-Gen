#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REMOVE_SHA = "09e78a0d62c5e568cd1b50b7f634c8f791a2116e8474674402e5e4c9fda0bec3";
const REPLACEMENT = Object.freeze({
  applicationReference: "SMD/2021/0211",
  applicationStatus: "approved",
  proposal: "SMD/2021/0211 24/03/2021 24/03/2021 Wildwood , Farley Lane , Farley , Staffordshire , ST10 4BZ Lawful Development Certificate for Proposed Development relating to the proposed erection of single storey side and rear extensions Certificate of Lawfulness - Lawful (Approved) 19/05/2021",
  url: "https://publicaccess.staffsmoorlands.gov.uk/portal/servlets/AttachmentShowServlet?ImageName=268359",
  transportUrl: "http://publicaccess.staffsmoorlands.gov.uk/portal/servlets/AttachmentShowServlet?ImageName=268359",
  tlsVerification: "legacy-http-official-host",
  role: "terrain-or-drainage",
  state: "unknown",
  text: "Topographical Survey",
  score: 100,
  bytes: 469257,
  sha256: "82cac12a14cd3d9d4232f409e681bd977f6c7f4f03be7b9049a6f845375543a9",
  mime: "application/pdf"
});

function replacementEntry() {
  return {
    kind: "document",
    url: REPLACEMENT.url,
    finalUrl: REPLACEMENT.url,
    transportUrl: REPLACEMENT.transportUrl,
    file: `files/${REPLACEMENT.sha256}.pdf`,
    applicationReference: REPLACEMENT.applicationReference,
    bytes: REPLACEMENT.bytes,
    sha256: REPLACEMENT.sha256,
    mime: REPLACEMENT.mime,
    transport: "node-http-official-document-balanced",
    tlsVerification: REPLACEMENT.tlsVerification
  };
}

function replacementDocument() {
  return {
    url: REPLACEMENT.url,
    transportUrl: REPLACEMENT.transportUrl,
    role: REPLACEMENT.role,
    state: REPLACEMENT.state,
    text: REPLACEMENT.text,
    score: REPLACEMENT.score,
    bytes: REPLACEMENT.bytes,
    sha256: REPLACEMENT.sha256,
    mime: REPLACEMENT.mime
  };
}

export function normalizeAltonPlanningCorpus(manifest) {
  const entries = (manifest.entries || []).filter((entry) => entry?.sha256 !== REMOVE_SHA);
  if (!entries.some((entry) => entry.sha256 === REPLACEMENT.sha256)) entries.push(replacementEntry());

  const applications = [];
  for (const application of manifest.applications || []) {
    const downloadedDocuments = (application.downloadedDocuments || []).filter((document) => document?.sha256 !== REMOVE_SHA);
    if (application.reference === REPLACEMENT.applicationReference && !downloadedDocuments.some((document) => document.sha256 === REPLACEMENT.sha256)) {
      downloadedDocuments.push(replacementDocument());
    }
    if (!downloadedDocuments.length) continue;
    applications.push({ ...application, downloadedDocuments });
  }

  if (!applications.some((application) => application.reference === REPLACEMENT.applicationReference)) {
    applications.push({
      reference: REPLACEMENT.applicationReference,
      status: REPLACEMENT.applicationStatus,
      proposal: REPLACEMENT.proposal,
      downloadedDocuments: [replacementDocument()]
    });
  }

  const totalBytes = entries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const normalized = {
    ...manifest,
    liveApplications: applications.length,
    documentsDownloaded: entries.length,
    totalBytes,
    applications,
    entries,
    warnings: [
      ...(manifest.warnings || []),
      `benchmark-corpus: replaced report ${REMOVE_SHA} with approved topographical survey ${REPLACEMENT.sha256}`
    ]
  };
  return normalized;
}

async function main() {
  const root = path.resolve(process.argv[2] || "benchmark/alton-planning-subset");
  const filename = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(filename, "utf8"));
  const normalized = normalizeAltonPlanningCorpus(manifest);
  await writeFile(filename, JSON.stringify(normalized, null, 2));
  console.log(JSON.stringify({
    status: "normalized",
    documents: normalized.documentsDownloaded,
    applications: normalized.liveApplications,
    bytes: normalized.totalBytes,
    replacement: REPLACEMENT.sha256
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 2;
  });
}
