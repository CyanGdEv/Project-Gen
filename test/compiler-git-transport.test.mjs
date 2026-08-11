import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXPECTED = [
  "git@github.com:",
  "ssh://git@github.com/",
  "git+ssh://git@github.com/",
  "git://github.com/"
];

test("compiler dependency transport rewrites GitHub SSH/git URLs to HTTPS without disabling verification", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "project-gen-git-transport-"));
  try {
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
    const helper = path.resolve("scripts/configure-compiler-git-transport.sh");
    const { stdout } = await execFileAsync("bash", [helper], { env });
    assert.match(stdout, /HTTPS-normalized/);

    const { stdout: configured } = await execFileAsync(
      "git",
      ["config", "--global", "--get-all", "url.https://github.com/.insteadOf"],
      { env }
    );
    const values = configured.trim().split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(values, [...EXPECTED].sort());

    const { stdout: sshCommand } = await execFileAsync(
      "git",
      ["config", "--global", "--get", "core.sshCommand"],
      { env }
    ).catch((error) => ({ stdout: error?.stdout || "" }));
    assert.equal(String(sshCommand || "").trim(), "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
