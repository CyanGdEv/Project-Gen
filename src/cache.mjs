import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function contentKey(namespace, input) {
  const digest = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(JSON.stringify(stable(input)))
    .digest("hex");
  return `${namespace}-${digest}`;
}

export class FileArtifactCache {
  constructor(root) {
    this.root = path.resolve(root);
  }

  fileFor(key) {
    if (!/^[a-z0-9._-]+$/i.test(key)) throw new Error("unsafe cache key");
    return path.join(this.root, `${key}.json`);
  }

  async get(key) {
    try {
      return JSON.parse(await readFile(this.fileFor(key), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async put(key, value) {
    await mkdir(this.root, { recursive: true });
    const target = this.fileFor(key);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(value));
    await rename(temp, target);
    return value;
  }

  async getOrCreate(key, producer) {
    const existing = await this.get(key);
    if (existing !== null) return { value: existing, cacheHit: true };
    const value = await producer();
    await this.put(key, value);
    return { value, cacheHit: false };
  }
}
