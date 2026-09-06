/**
 * Loader integration tests — run by `bun test` (test:bun), NOT vitest: the
 * cache-busting assertion depends on BUN's real dynamic-import module cache
 * (the §9 spike made concrete). See plugin-discovery.ts for the spike record.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Logger } from "@dispatch/kernel";
import { loadPlugin } from "./plugin-discovery.js";

function makeLogger(): Logger {
  const noop = () => {};
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    span: () => {
      throw new Error("not used");
    },
  } as unknown as Logger;
  return logger;
}

function pluginSource(version: string, extra = ""): string {
  return `
export const manifest = {
  id: "fixture-plugin",
  name: "Fixture Plugin",
  version: "${version}",
  apiVersion: "^0.1.0",
  tier: "standard",
  trust: "external",
};
export const extension = { manifest, activate: () => {} };
${extra}
`;
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dispatch-plugin-load-test-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write (or rewrite) a plugin entry AND force its mtime to `versionStamp`. */
async function writeEntry(filePath: string, content: string, versionStamp?: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  if (versionStamp !== undefined) {
    // Deterministic mtime: the cache-busting query uses mtimeMs, so a test
    // rewrite must land on a DIFFERENT mtime than the previous load even on
    // coarse-timestamp filesystems.
    const at = new Date(versionStamp);
    await utimes(filePath, at, at);
  }
}

describe("loadPlugin", () => {
  it("loads a fixture plugin (extension export) from a directory entry", async () => {
    const entry = path.join(root, "basic", "index.ts");
    await writeEntry(entry, pluginSource("1.0.0"));
    const ext = await loadPlugin(entry, makeLogger());
    expect(ext).toBeDefined();
    expect(ext?.manifest.id).toBe("fixture-plugin");
    expect(typeof ext?.activate).toBe("function");
  });

  it("resolves a plugin's internal relative imports (sibling files)", async () => {
    const dir = path.join(root, "with-sibling");
    await writeEntry(
      path.join(dir, "index.ts"),
      'import { HELLO } from "./helper.js";\n' +
        'export const manifest = { id: "sibling", name: "s", version: "1.0.0", apiVersion: "^0.1.0", tier: "standard", trust: "external" };\n' +
        "export const extension = { manifest, activate: () => { HELLO; } };\n",
    );
    await writeEntry(path.join(dir, "helper.js"), 'export const HELLO = "from-sibling";\n');
    const ext = await loadPlugin(path.join(dir, "index.ts"), makeLogger());
    expect(ext?.manifest.id).toBe("sibling");
  });

  it("skips a module with no valid extension export (undefined, no throw)", async () => {
    const entry = path.join(root, "no-extension", "index.ts");
    await writeEntry(entry, "export const notAnExtension = 42;\n");
    const ext = await loadPlugin(entry, makeLogger());
    expect(ext).toBeUndefined();
  });

  it("skips a syntactically broken plugin without crashing (fault isolation)", async () => {
    const entry = path.join(root, "broken", "index.ts");
    await writeEntry(entry, "export const extension = { broken syntax !!!\n");
    const ext = await loadPlugin(entry, makeLogger());
    expect(ext).toBeUndefined();
  });

  it("skips a nonexistent entry without throwing", async () => {
    const ext = await loadPlugin(path.join(root, "ghost", "index.ts"), makeLogger());
    expect(ext).toBeUndefined();
  });
});

describe("cache-busted reload (§9 — the spike made concrete)", () => {
  it("picks up NEW code after the file changes and its mtime moves", async () => {
    const entry = path.join(root, "cache-bust", "index.ts");
    await writeEntry(entry, pluginSource("1.0.0"));

    const first = await loadPlugin(entry, makeLogger());
    expect(first?.manifest.version).toBe("1.0.0");

    // Author updates the plugin: new content + a moved mtime (the loader's
    // cache key is `?v=<mtimeMs>`).
    const oldStat = await stat(entry);
    await writeEntry(entry, pluginSource("2.0.0"), oldStat.mtimeMs + 5000);

    const second = await loadPlugin(entry, makeLogger());
    expect(second?.manifest.version).toBe("2.0.0");
    expect(second).not.toBe(first); // a FRESH module instance, not stale cache
  });

  it("serves a CACHED instance for an unchanged file (same mtime query)", async () => {
    const entry = path.join(root, "cache-stable", "index.ts");
    await writeEntry(entry, pluginSource("3.0.0"));
    const a = await loadPlugin(entry, makeLogger());
    const b = await loadPlugin(entry, makeLogger());
    expect(a).toBeDefined();
    expect(a).toBe(b); // same mtime → same module instance
  });
});
