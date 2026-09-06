import type { Manifest } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  type DiscoveredPlugin,
  decodeOverrideRecord,
  encodeOverrideRecord,
  type PluginOverrideRecord,
  reconcilePlugins,
  resolvePluginsDir,
  validatePluginManifest,
} from "./plugin-reconcile.js";

const KERNEL = "0.1.0";

/** A minimally VALID manifest (the post-plan-02 required set). */
function validManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    apiVersion: "^0.1.0",
    tier: "standard",
    trust: "external",
    ...overrides,
  };
}

function discovered(manifest: Manifest, dir?: string): DiscoveredPlugin {
  const d = dir ?? `/plugins/${manifest.id}`;
  return { dir: d, manifest, entryPath: `${d}/index.ts` };
}

describe("validatePluginManifest", () => {
  it("accepts a valid minimal manifest", () => {
    const result = validatePluginManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("my-plugin");
      expect(result.warnings).toEqual([]);
    }
  });

  it("accepts a manifest with every optional field present and well-shaped", () => {
    const result = validatePluginManifest({
      ...validManifest({
        dependsOn: ["other-plugin"],
        entry: "src/main.ts",
        activation: "eager",
      }),
      contributes: { tools: ["my-tool"], services: ["my-service"] },
      capabilities: { fs: true, network: false },
      frontend: { apiVersion: "^1.0.0", entry: "./ui/main.js" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it("rejects a non-object payload", () => {
    expect(validatePluginManifest("nope").ok).toBe(false);
    expect(validatePluginManifest(null).ok).toBe(false);
    expect(validatePluginManifest([validManifest()]).ok).toBe(false);
  });

  it("reports EVERY missing required field, not just the first", () => {
    const result = validatePluginManifest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const field of ["id", "name", "version", "apiVersion", "tier", "trust"]) {
        expect(result.errors.some((e) => e.includes(`"${field}"`))).toBe(true);
      }
    }
  });

  it("rejects an invalid tier (post-plan-02 required field)", () => {
    const result = validatePluginManifest(validManifest({ tier: "kernel" as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("tier"))).toBe(true);
  });

  it("rejects an invalid trust level", () => {
    const result = validatePluginManifest(validManifest({ trust: "trusted" as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("trust"))).toBe(true);
  });

  it("rejects an unparseable apiVersion range", () => {
    const result = validatePluginManifest(validManifest({ apiVersion: "not-a-range" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("apiVersion"))).toBe(true);
  });

  it("accepts a parseable-but-incompatible apiVersion (compat is reconcile/scan's job)", () => {
    // The validator checks RANGE FORMAT only; apiVersion compatibility with
    // the running kernel surfaces as its own scan status / reconcile row.
    const result = validatePluginManifest(validManifest({ apiVersion: "^9.9.9" }));
    expect(result.ok).toBe(true);
  });

  it("rejects contributes.migrations in a runtime plugin (loud, not silently dropped)", () => {
    const result = validatePluginManifest({
      ...validManifest(),
      contributes: { migrations: ["001-init"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("migrations"))).toBe(true);
      expect(result.errors.some((e) => e.includes("runtime plugins"))).toBe(true);
    }
  });

  it("warns on a directory-name / id mismatch and trusts manifest.id", () => {
    const result = validatePluginManifest(validManifest({ id: "real-id" }), {
      dirName: "wrong-dir-name",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("wrong-dir-name");
      expect(result.warnings[0]).toContain("real-id");
    }
  });

  it("does not warn when the directory name matches the id", () => {
    const result = validatePluginManifest(validManifest({ id: "my-plugin" }), {
      dirName: "my-plugin",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it("rejects malformed optional fields", () => {
    const cases: Record<string, unknown>[] = [
      { dependsOn: "other" },
      { dependsOn: [42] },
      { entry: "" },
      { activation: 3 },
    ];
    for (const patch of cases) {
      const result = validatePluginManifest(validManifest(patch));
      expect(result.ok).toBe(false);
    }
    expect(
      validatePluginManifest({ ...validManifest(), contributes: { tools: "not-an-array" } }).ok,
    ).toBe(false);
    expect(validatePluginManifest({ ...validManifest(), capabilities: { fs: "yes" } }).ok).toBe(
      false,
    );
    expect(
      validatePluginManifest({ ...validManifest(), frontend: { apiVersion: "^1.0.0" } }).ok,
    ).toBe(false);
  });
});

describe("reconcilePlugins (boot mode — §6 rules)", () => {
  const boot = (loadedIds: string[] = []) => ({
    kernelApiVersion: KERNEL,
    loadedIds,
    mode: "boot" as const,
  });

  it("loads a present, compatible plugin with no disable-record (default-on)", () => {
    const plan = reconcilePlugins([discovered(validManifest())], new Map(), boot());
    expect(plan.toLoad.map((p) => p.manifest.id)).toEqual(["my-plugin"]);
    expect(plan.disabledByOverride).toEqual([]);
    expect(plan.disabledWithReason).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("leaves a present plugin unloaded when a disable-record exists", () => {
    const record: PluginOverrideRecord = { disabled: true, reason: "user choice" };
    const plan = reconcilePlugins(
      [discovered(validManifest())],
      new Map([["my-plugin", record]]),
      boot(),
    );
    expect(plan.toLoad).toEqual([]);
    expect(plan.disabledByOverride).toHaveLength(1);
    expect(plan.disabledByOverride[0]?.record.reason).toBe("user choice");
    expect(plan.disabledWithReason).toEqual([]);
  });

  it("reports a record whose plugin dir is gone as a 'missing' row", () => {
    const record: PluginOverrideRecord = { disabled: true };
    const plan = reconcilePlugins([], new Map([["gone-plugin", record]]), boot());
    expect(plan.missing).toHaveLength(1);
    expect(plan.missing[0]?.id).toBe("gone-plugin");
    expect(plan.toLoad).toEqual([]);
  });

  it("does not report a discovered id as missing", () => {
    const record: PluginOverrideRecord = { disabled: true };
    const plan = reconcilePlugins(
      [discovered(validManifest())],
      new Map([
        ["my-plugin", record],
        ["gone-plugin", record],
      ]),
      boot(),
    );
    expect(plan.missing.map((m) => m.id)).toEqual(["gone-plugin"]);
    expect(plan.disabledByOverride.map((d) => d.manifest.id)).toEqual(["my-plugin"]);
  });

  it("routes an apiVersion-incompatible plugin to disabled-with-reason", () => {
    const plan = reconcilePlugins(
      [discovered(validManifest({ apiVersion: "^9.9.9" }))],
      new Map(),
      boot(),
    );
    expect(plan.toLoad).toEqual([]);
    expect(plan.disabledWithReason).toHaveLength(1);
    expect(plan.disabledWithReason[0]?.reason).toContain("apiVersion");
    expect(plan.disabledWithReason[0]?.reason).toContain("incompatible");
  });

  it("prefers the incompatible reason over a disable-record for the same plugin", () => {
    const record: PluginOverrideRecord = { disabled: true };
    const plan = reconcilePlugins(
      [discovered(validManifest({ apiVersion: "^9.9.9" }))],
      new Map([["my-plugin", record]]),
      boot(),
    );
    expect(plan.disabledWithReason).toHaveLength(1);
    expect(plan.disabledByOverride).toEqual([]);
  });

  it("refuses a plugin whose dependency is unavailable (non-throwing DAG mode)", () => {
    const plan = reconcilePlugins(
      [discovered(validManifest({ id: "dependent", dependsOn: ["missing-dep"] }))],
      new Map(),
      boot(),
    );
    expect(plan.toLoad).toEqual([]);
    expect(plan.disabledWithReason).toHaveLength(1);
    expect(plan.disabledWithReason[0]?.reason).toBe(
      'Extension "dependent" depends on "missing-dep", which is not loaded',
    );
  });

  it("loads a plugin whose dependency is already loaded", () => {
    const plan = reconcilePlugins(
      [discovered(validManifest({ id: "dependent", dependsOn: ["bundled-base"] }))],
      new Map(),
      boot(["bundled-base"]),
    );
    expect(plan.toLoad.map((p) => p.manifest.id)).toEqual(["dependent"]);
  });

  it("orders inter-dependent candidates dependency-first", () => {
    const a = discovered(validManifest({ id: "plugin-a" }));
    const b = discovered(validManifest({ id: "plugin-b", dependsOn: ["plugin-a"] }));
    const c = discovered(validManifest({ id: "plugin-c", dependsOn: ["plugin-b"] }));
    const plan = reconcilePlugins([c, b, a], new Map(), boot());
    expect(plan.toLoad.map((p) => p.manifest.id)).toEqual(["plugin-a", "plugin-b", "plugin-c"]);
  });

  it("refuses a plugin that depends on a disable-recorded candidate", () => {
    const base = validManifest({ id: "base-plugin" });
    const dependent = discovered(validManifest({ id: "dependent", dependsOn: ["base-plugin"] }));
    const record: PluginOverrideRecord = { disabled: true };
    const plan = reconcilePlugins(
      [dependent, discovered(base)],
      new Map([["base-plugin", record]]),
      boot(),
    );
    expect(plan.disabledByOverride.map((d) => d.manifest.id)).toEqual(["base-plugin"]);
    expect(plan.disabledWithReason).toHaveLength(1);
    expect(plan.disabledWithReason[0]?.manifest.id).toBe("dependent");
    expect(plan.disabledWithReason[0]?.reason).toContain("base-plugin");
  });

  it("refuses an id that collides with a loaded extension (boot mode)", () => {
    const plan = reconcilePlugins([discovered(validManifest())], new Map(), boot(["my-plugin"]));
    expect(plan.toLoad).toEqual([]);
    expect(plan.disabledWithReason[0]?.reason).toContain("already loaded");
  });

  it("lets the FIRST directory win on duplicate ids and refuses the later one", () => {
    const first = discovered(validManifest({ id: "dup" }), "/plugins/dup-one");
    const second = discovered(validManifest({ id: "dup" }), "/plugins/dup-two");
    const plan = reconcilePlugins([first, second], new Map(), boot());
    expect(plan.toLoad.map((p) => p.dir)).toEqual(["/plugins/dup-one"]);
    expect(plan.disabledWithReason).toHaveLength(1);
    expect(plan.disabledWithReason[0]?.reason).toContain("duplicate");
  });
});

describe("reconcilePlugins (scan mode — the consent gate)", () => {
  const scan = (loadedIds: string[] = []) => ({
    kernelApiVersion: KERNEL,
    loadedIds,
    mode: "scan" as const,
  });

  it("lists NEW discoveries as UNCHECKED instead of loading them (§5)", () => {
    const plan = reconcilePlugins([discovered(validManifest())], new Map(), scan());
    expect(plan.toLoad).toEqual([]); // never auto-loads mid-session
    expect(plan.unchecked.map((p) => p.manifest.id)).toEqual(["my-plugin"]);
  });

  it("reports ids that are already live as alreadyLoaded (scan bookkeeping)", () => {
    const plan = reconcilePlugins([discovered(validManifest())], new Map(), scan(["my-plugin"]));
    expect(plan.alreadyLoaded.map((p) => p.manifest.id)).toEqual(["my-plugin"]);
    expect(plan.unchecked).toEqual([]);
    expect(plan.disabledWithReason).toEqual([]);
  });

  it("still routes incompatible / dep-unmet plugins to disabled-with-reason in scan mode", () => {
    const plan = reconcilePlugins(
      [
        discovered(validManifest({ id: "bad-api", apiVersion: "^9.9.9" })),
        discovered(validManifest({ id: "dep-unmet", dependsOn: ["nope"] })),
        discovered(validManifest({ id: "fine" })),
      ],
      new Map(),
      scan(),
    );
    expect(plan.unchecked.map((p) => p.manifest.id)).toEqual(["fine"]);
    expect(plan.disabledWithReason.map((d) => d.manifest.id).sort()).toEqual([
      "bad-api",
      "dep-unmet",
    ]);
  });
});

describe("resolvePluginsDir", () => {
  it("DISPATCH_PLUGINS_DIR wins over everything", () => {
    expect(
      resolvePluginsDir({ DISPATCH_PLUGINS_DIR: "/opt/plugins", XDG_DATA_HOME: "/xdg" }, "/home/u"),
    ).toBe("/opt/plugins");
  });

  it("uses $XDG_DATA_HOME/dispatch/plugins when the env override is unset", () => {
    expect(resolvePluginsDir({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg/dispatch/plugins");
  });

  it("falls back to ~/.local/share/dispatch/plugins (XDG data home default)", () => {
    expect(resolvePluginsDir({}, "/home/u")).toBe("/home/u/.local/share/dispatch/plugins");
  });

  it("treats empty-string env values as unset", () => {
    expect(resolvePluginsDir({ DISPATCH_PLUGINS_DIR: "  ", XDG_DATA_HOME: "" }, "/home/u")).toBe(
      "/home/u/.local/share/dispatch/plugins",
    );
  });
});

describe("override record (de)serialization", () => {
  it("round-trips a record through encode/decode", () => {
    const record: PluginOverrideRecord = {
      disabled: true,
      reason: "not wanted",
      disabledAt: "2026-09-02T00:00:00.000Z",
    };
    expect(decodeOverrideRecord(encodeOverrideRecord(record))).toEqual(record);
  });

  it("returns undefined for garbage instead of throwing", () => {
    expect(decodeOverrideRecord("not json {")).toBeUndefined();
    expect(decodeOverrideRecord('"just a string"')).toBeUndefined();
    expect(decodeOverrideRecord('{"disabled":false}')).toBeUndefined();
    expect(decodeOverrideRecord('{"reason":"no disabled flag"}')).toBeUndefined();
  });
});
