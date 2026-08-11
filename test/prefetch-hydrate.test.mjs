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

test("planning hydrator retries transient fetch failures but still verifies exact evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-gen-hydrate-retry-"));
  try {
    const body = Buffer.from("retry-safe planning evidence");
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
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(body, { status: 200 });
    };
    const result = await hydratePlanningPrefetch(root, { fetchImpl, retries: 2, retryDelayMs: 0 });
    assert.equal(result.downloaded, 1);
    assert.equal(result.retriedDocuments, 1);
    assert.equal(result.totalAttempts, 2);
    assert.equal(calls, 2);
    assert.deepEqual(await readFile(path.join(root, entry.file)), body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning hydrator does not retry integrity mismatches and leaves no partial evidence", async () => {
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
    let calls = 0;
    await assert.rejects(
      hydratePlanningPrefetch(root, {
        retries: 4,
        retryDelayMs: 0,
        fetchImpl: async () => {
          calls += 1;
          return new Response(actual, { status: 200 });
        }
      }),
      /sha256 mismatch/
    );
    assert.equal(calls, 1);
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
    await assert.rejects(
      hydratePlanningPrefetch(root, { fetchImpl, retries: 0, retryDelayMs: 0 }),
      /legacy TLS unavailable/
    );
    const result = await hydratePlanningPrefetch(root, { fetchImpl, allowLegacyHttpTransport: true, retries: 0 });
    assert.equal(result.downloaded, 1);
    assert.equal(seen.at(-1), "http://planning.example/document.pdf");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
