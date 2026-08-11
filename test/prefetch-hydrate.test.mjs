import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hydratePlanningPrefetch } from "../src/planning/prefetch-hydrate.mjs";

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(root, entries) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    status: "usable",
    liveApplications: 1,
    documentsDownloaded: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    applications: [],
    entries,
    attempts: [],
    warnings: []
  }));
}

test("planning hydrator downloads and then reuses exact manifest-pinned evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-hydrate-"));
  try {
    const body = Buffer.from("real planning bytes");
    const entry = {
      kind: "document",
      url: "https://planning.example/document.pdf",
      file: `files/${sha(body)}.pdf`,
      bytes: body.length,
      sha256: sha(body),
      mime: "application/pdf"
    };
    await fixture(root, [entry]);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
    };
    const cold = await hydratePlanningPrefetch(root, { fetchImpl });
    const warm = await hydratePlanningPrefetch(root, { fetchImpl });
    assert.equal(cold.downloaded, 1);
    assert.equal(warm.reused, 1);
    assert.equal(calls, 1);
    assert.deepEqual(await readFile(path.join(root, entry.file)), body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning hydrator rejects hash mismatches without leaving partial evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-hydrate-bad-"));
  try {
    const expected = Buffer.from("expected");
    const actual = Buffer.from("tampered");
    const entry = {
      kind: "document",
      url: "https://planning.example/document.pdf",
      file: `files/${sha(expected)}.pdf`,
      bytes: actual.length,
      sha256: sha(expected),
      mime: "application/pdf"
    };
    await fixture(root, [entry]);
    await assert.rejects(
      hydratePlanningPrefetch(root, { fetchImpl: async () => new Response(actual, { status: 200 }) }),
      /sha256 mismatch/
    );
    await assert.rejects(readFile(path.join(root, entry.file)), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy HTTP transport requires explicit opt-in and same official host", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-hydrate-http-"));
  try {
    const body = Buffer.from("legacy official evidence");
    const entry = {
      kind: "document",
      url: "https://planning.example/document.pdf",
      transportUrl: "http://planning.example/document.pdf",
      tlsVerification: "legacy-http-official-host",
      file: `files/${sha(body)}.pdf`,
      bytes: body.length,
      sha256: sha(body),
      mime: "application/pdf"
    };
    await fixture(root, [entry]);
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (String(url).startsWith("https:")) throw new Error("legacy TLS unavailable");
      return new Response(body, { status: 200 });
    };
    await assert.rejects(hydratePlanningPrefetch(root, { fetchImpl }), /legacy TLS unavailable/);
    const result = await hydratePlanningPrefetch(root, { fetchImpl, allowLegacyHttpTransport: true });
    assert.equal(result.downloaded, 1);
    assert.equal(seen.at(-1), "http://planning.example/document.pdf");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
