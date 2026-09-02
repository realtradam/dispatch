import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Logger } from "@dispatch/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanPlugins } from "./plugin-discovery.js";

/** Noop logger (scan tests assert on the RESULT, not the logs). */
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

const VALID_MANIFEST = {
  id: "fixture-plugin",
  name: "Fixture Plugin",
  version: "1.0.0",
  apiVersion: "^0.1.0",
  tier: "standard",
  trust: "external",
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dispatch-plugins-test-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a plugin directory into the fixture root. */
async function writePlugin(dirName: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return dir;
}

const INDEX = "export const extension = { manifest: {}, activate: () => {} };\n";

function statusOf(result: Awaited<ReturnType<typeof scanPlugins>>, dirName: string) {
  return result.plugins.find((p) => p.dir === path.join(root, dirName))?.status;
}

describe("scanPlugins", () => {
  it("scans an empty/missing root as empty (no boot crash)", async () => {
    const missing = path.join(root, "does-not-exist");
    const result = await scanPlugins(missing, makeLogger());
    expect(result.root).toBe(missing);
    expect(result.plugins).toEqual([]);
  });

  it("classifies a valid plugin directory as loadable with a resolved entry", async () => {
    await writePlugin("valid", {
      "manifest.json": JSON.stringify(VALID_MANIFEST),
      "index.ts": INDEX,
    });
    const result = await scanPlugins(root, makeLogger());
    const status = statusOf(result, "valid");
    expect(status?.kind).toBe("loadable");
    if (status?.kind === "loadable") {
      expect(status.manifest.id).toBe("fixture-plugin");
      expect(status.entryPath).toBe(path.join(root, "valid", "index.ts"));
    }
  });

  it("prefers index.ts over index.js (conventional entries)", async () => {
    await writePlugin("both", {
      "manifest.json": JSON.stringify(VALID_MANIFEST),
      "index.js": INDEX,
      "index.ts": INDEX,
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "both");
    if (status?.kind === "loadable") {
      expect(status.entryPath).toBe(path.join(root, "both", "index.ts"));
    } else {
      throw new Error(`expected loadable, got ${JSON.stringify(status)}`);
    }
  });

  it("falls back to index.js when there is no index.ts", async () => {
    await writePlugin("js-only", {
      "manifest.json": JSON.stringify(VALID_MANIFEST),
      "index.js": INDEX,
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "js-only");
    if (status?.kind === "loadable") {
      expect(status.entryPath).toBe(path.join(root, "js-only", "index.js"));
    } else {
      throw new Error(`expected loadable, got ${JSON.stringify(status)}`);
    }
  });

  it("honors the manifest's `entry` override (relative to the plugin dir)", async () => {
    await writePlugin("entry-override", {
      "manifest.json": JSON.stringify({ ...VALID_MANIFEST, entry: "src/main.ts" }),
      "src/main.ts": INDEX,
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "entry-override");
    if (status?.kind === "loadable") {
      expect(status.entryPath).toBe(path.join(root, "entry-override", "src", "main.ts"));
    } else {
      throw new Error(`expected loadable, got ${JSON.stringify(status)}`);
    }
  });

  it("rejects a manifest whose `entry` points at a missing file", async () => {
    await writePlugin("entry-missing", {
      "manifest.json": JSON.stringify({ ...VALID_MANIFEST, entry: "gone.ts" }),
      "index.ts": INDEX,
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "entry-missing");
    expect(status?.kind).toBe("invalid");
    if (status?.kind === "invalid") {
      expect(status.errors[0]).toContain("gone.ts");
    }
  });

  it("rejects a manifest whose `entry` escapes the plugin directory", async () => {
    await writePlugin("entry-escape", {
      "manifest.json": JSON.stringify({ ...VALID_MANIFEST, entry: "../outside.ts" }),
      "index.ts": INDEX,
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "entry-escape");
    expect(status?.kind).toBe("invalid");
    if (status?.kind === "invalid") {
      expect(status.errors[0]).toContain("escapes");
    }
  });

  it("rejects a directory with no code entry at all", async () => {
    await writePlugin("no-entry", {
      "manifest.json": JSON.stringify(VALID_MANIFEST),
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "no-entry");
    expect(status?.kind).toBe("invalid");
    if (status?.kind === "invalid") {
      expect(status.errors[0]).toContain("no code entry found");
    }
  });

  it("fails loudly on malformed manifest.json", async () => {
    await writePlugin("bad-json", { "manifest.json": "{ not json", "index.ts": INDEX });
    const status = statusOf(await scanPlugins(root, makeLogger()), "bad-json");
    expect(status?.kind).toBe("invalid");
    if (status?.kind === "invalid") {
      expect(status.errors[0]).toContain("not valid JSON");
    }
  });

  it("fails loudly on a missing manifest.json", async () => {
    await writePlugin("no-manifest", { "index.ts": INDEX });
    const status = statusOf(await scanPlugins(root, makeLogger()), "no-manifest");
    expect(status?.kind).toBe("invalid");
    if (status?.kind === "invalid") {
      expect(status.errors[0]).toContain("manifest.json not found");
    }
  });

  it("fails validation errors through to an invalid status (bad tier)", async () => {
    await writePlugin("bad-tier", {
      "manifest.json": JSON.stringify({ ...VALID_MANIFEST, tier: "kernel" }),
      "index.ts": INDEX,
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "bad-tier");
    expect(status?.kind).toBe("invalid");
    if (status?.kind === "invalid") {
      expect(status.errors.some((e) => e.includes("tier"))).toBe(true);
    }
  });

  it("rejects contributes.migrations at scan time", async () => {
    await writePlugin("with-migrations", {
      "manifest.json": JSON.stringify({
        ...VALID_MANIFEST,
        contributes: { migrations: ["001-init"] },
      }),
      "index.ts": INDEX,
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "with-migrations");
    expect(status?.kind).toBe("invalid");
    if (status?.kind === "invalid") {
      expect(status.errors.some((e) => e.includes("migrations"))).toBe(true);
    }
  });

  it("classifies an apiVersion-incompatible manifest as incompatible (not invalid)", async () => {
    await writePlugin("wrong-api", {
      "manifest.json": JSON.stringify({ ...VALID_MANIFEST, apiVersion: "^9.9.9" }),
      "index.ts": INDEX,
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "wrong-api");
    expect(status?.kind).toBe("incompatible");
    if (status?.kind === "incompatible") {
      expect(status.reason).toContain("apiVersion");
      expect(status.manifest.id).toBe("fixture-plugin");
    }
  });

  it("trusts manifest.id on a directory-name mismatch (loadable)", async () => {
    await writePlugin("mismatched-dir-name", {
      "manifest.json": JSON.stringify(VALID_MANIFEST),
      "index.ts": INDEX,
    });
    const status = statusOf(await scanPlugins(root, makeLogger()), "mismatched-dir-name");
    expect(status?.kind).toBe("loadable");
  });

  it("skips non-directories and dot-directories", async () => {
    await writeFile(path.join(root, "a-loose-file.txt"), "not a plugin");
    await writePlugin(".hidden", { "manifest.json": JSON.stringify(VALID_MANIFEST) });
    const result = await scanPlugins(root, makeLogger());
    const dirs = result.plugins.map((p) => p.dir);
    expect(dirs.some((d) => d.endsWith("a-loose-file.txt"))).toBe(false);
    expect(dirs.some((d) => d.endsWith(".hidden"))).toBe(false);
  });
});
