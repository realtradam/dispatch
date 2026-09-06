import type { Manifest } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import type { ReconciledScanBuckets, ScannedPluginEntry } from "./engine.js";
import {
  classifyFrontendAccess,
  classifyReload,
  classifyUnload,
  computeUnloadCascade,
  deriveListView,
  deriveScanResponse,
  findLoadableEntry,
  overrideForUnload,
  toLoadedRow,
} from "./pure.js";

function manifest(id: string, extra: Partial<Manifest> = {}): Manifest {
  return {
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    apiVersion: "^0.1.0",
    tier: "standard",
    trust: "bundled",
    ...extra,
  };
}

const emptyBuckets: ReconciledScanBuckets = {
  unchecked: [],
  alreadyLoaded: [],
  disabledByOverride: [],
  disabledWithReason: [],
  missing: [],
};

// ── toLoadedRow ─────────────────────────────────────────────────────────────

describe("toLoadedRow", () => {
  it("marks core-tier plugins as locked and standard as unlocked", () => {
    const core = toLoadedRow(manifest("core-one", { tier: "core" }));
    const std = toLoadedRow(manifest("std-one"));
    expect(core.locked).toBe(true);
    expect(std.locked).toBe(false);
  });

  it("carries dependsOn through", () => {
    const row = toLoadedRow(manifest("a", { dependsOn: ["b", "c"] }));
    expect(row.dependsOn).toEqual(["b", "c"]);
  });
});

// ── computeUnloadCascade ────────────────────────────────────────────────────

describe("computeUnloadCascade", () => {
  it("returns empty for a plugin nobody depends on", () => {
    const loaded = [manifest("a"), manifest("b")];
    expect(computeUnloadCascade(loaded, "a")).toEqual([]);
  });

  it("finds direct dependents", () => {
    const loaded = [manifest("a"), manifest("b", { dependsOn: ["a"] })];
    expect(computeUnloadCascade(loaded, "a")).toEqual(["b"]);
  });

  it("finds TRANSITIVE dependents, leaf dependents first (reverse topological)", () => {
    // a ← b ← c (c depends on b, b depends on a): unloading a cascades c, b.
    const loaded = [
      manifest("a"),
      manifest("b", { dependsOn: ["a"] }),
      manifest("c", { dependsOn: ["b"] }),
    ];
    const cascade = computeUnloadCascade(loaded, "a");
    expect(cascade).toEqual(["c", "b"]);
  });

  it("the target itself is never in its own cascade", () => {
    const loaded = [manifest("a", { dependsOn: ["a"] })];
    expect(computeUnloadCascade(loaded, "a")).toEqual([]);
  });

  it("ignores unrelated dependency branches", () => {
    const loaded = [
      manifest("a"),
      manifest("b", { dependsOn: ["a"] }),
      manifest("c", { dependsOn: ["b"] }),
      manifest("x"),
      manifest("y", { dependsOn: ["x"] }),
    ];
    expect(computeUnloadCascade(loaded, "a")).toEqual(["c", "b"]);
  });
});

// ── classifyUnload (§8 policy) ──────────────────────────────────────────────

describe("classifyUnload", () => {
  it("blocks a target that is not loaded", () => {
    const decision = classifyUnload({ loaded: [manifest("a")], targetId: "ghost", force: false });
    expect(decision).toMatchObject({ kind: "blocked", reason: "not-loaded" });
  });

  it("refuses core plugins (never force-able)", () => {
    const loaded = [manifest("plugin-manager", { tier: "core" })];
    for (const force of [false, true]) {
      const decision = classifyUnload({ loaded, targetId: "plugin-manager", force });
      expect(decision).toMatchObject({ kind: "blocked", reason: "core-locked" });
    }
  });

  it("refuses unloading the LAST loaded provider (never force-able)", () => {
    const loaded = [
      manifest("provider-one", { tier: "providers" }),
      manifest("tools", { tier: "standard" }),
    ];
    for (const force of [false, true]) {
      const decision = classifyUnload({ loaded, targetId: "provider-one", force });
      expect(decision).toMatchObject({ kind: "blocked", reason: "last-provider" });
    }
  });

  it("allows unloading a provider when others remain loaded", () => {
    const loaded = [
      manifest("provider-one", { tier: "providers" }),
      manifest("provider-two", { tier: "providers" }),
    ];
    const decision = classifyUnload({ loaded, targetId: "provider-one", force: false });
    expect(decision).toMatchObject({ kind: "allowed", cascade: [], stopAgents: false });
  });

  it("blocks with the dependent list when dependents exist and force is false", () => {
    const loaded = [
      manifest("a"),
      manifest("b", { dependsOn: ["a"] }),
      manifest("c", { dependsOn: ["b"] }),
    ];
    const decision = classifyUnload({ loaded, targetId: "a", force: false });
    expect(decision).toMatchObject({
      kind: "blocked",
      reason: "cascade-needs-force",
      dependents: ["c", "b"],
    });
  });

  it("allows with the full cascade and agent stop when force is true", () => {
    const loaded = [
      manifest("a"),
      manifest("b", { dependsOn: ["a"] }),
      manifest("c", { dependsOn: ["b"] }),
    ];
    const decision = classifyUnload({ loaded, targetId: "a", force: true });
    expect(decision).toMatchObject({ kind: "allowed", cascade: ["c", "b"], stopAgents: true });
  });

  it("force with no dependents still stops agents (in-use semantics, §8)", () => {
    const loaded = [manifest("a"), manifest("b")];
    const decision = classifyUnload({ loaded, targetId: "a", force: true });
    expect(decision).toMatchObject({ kind: "allowed", cascade: [], stopAgents: true });
  });

  it("plain unload with no dependents does not stop agents", () => {
    const loaded = [manifest("a"), manifest("b")];
    const decision = classifyUnload({ loaded, targetId: "a", force: false });
    expect(decision).toMatchObject({ kind: "allowed", cascade: [], stopAgents: false });
  });
});

// ── classifyReload ──────────────────────────────────────────────────────────

describe("classifyReload", () => {
  it("allows reloading an UNLOADED plugin (degenerates to load, no cascade)", () => {
    const decision = classifyReload({ loaded: [manifest("b")], targetId: "a", force: false });
    expect(decision).toMatchObject({ kind: "allowed", cascade: [], stopAgents: false });
  });

  it("blocks on loaded dependents without force (plan-01 §1.4)", () => {
    const loaded = [manifest("a"), manifest("b", { dependsOn: ["a"] })];
    const decision = classifyReload({ loaded, targetId: "a", force: false });
    expect(decision).toMatchObject({
      kind: "blocked",
      reason: "cascade-needs-force",
      dependents: ["b"],
    });
  });

  it("allows with force and reports the cascade + agent stop", () => {
    const loaded = [manifest("a"), manifest("b", { dependsOn: ["a"] })];
    const decision = classifyReload({ loaded, targetId: "a", force: true });
    expect(decision).toMatchObject({ kind: "allowed", cascade: ["b"], stopAgents: true });
  });

  it("does NOT apply the core lock (reload keeps the plugin loaded)", () => {
    const loaded = [manifest("core-x", { tier: "core" })];
    const decision = classifyReload({ loaded, targetId: "core-x", force: false });
    expect(decision).toMatchObject({ kind: "allowed", cascade: [] });
  });
});

// ── findLoadableEntry ───────────────────────────────────────────────────────

describe("findLoadableEntry", () => {
  it("finds the loadable entry by manifest id", () => {
    const scanned: ScannedPluginEntry[] = [
      { dir: "/plugins/a", kind: "invalid", errors: ["bad"] },
      {
        dir: "/plugins/b",
        kind: "loadable",
        manifest: manifest("b"),
        entryPath: "/plugins/b/index.ts",
      },
    ];
    const found = findLoadableEntry(scanned, "b");
    expect(found?.dir).toBe("/plugins/b");
  });

  it("returns undefined for invalid entries or unknown ids", () => {
    const scanned: ScannedPluginEntry[] = [{ dir: "/plugins/a", kind: "invalid", errors: ["bad"] }];
    expect(findLoadableEntry(scanned, "a")).toBeUndefined();
    expect(findLoadableEntry(scanned, "ghost")).toBeUndefined();
  });
});

// ── overrideForUnload ───────────────────────────────────────────────────────

describe("overrideForUnload", () => {
  it("records the unload kind, reason, and timestamp", () => {
    const record = overrideForUnload("2026-09-02T00:00:00.000Z");
    expect(record).toEqual({
      disabled: true,
      kind: "unloaded",
      reason: "unloaded by user",
      disabledAt: "2026-09-02T00:00:00.000Z",
    });
  });
});

// ── deriveListView ──────────────────────────────────────────────────────────

describe("deriveListView", () => {
  const scanOf = (
    overrides: Partial<ReconciledScanBuckets>,
    scanned: ScannedPluginEntry[] = [],
  ): {
    scanned: ScannedPluginEntry[];
    buckets: ReconciledScanBuckets;
  } => ({
    scanned,
    buckets: { ...emptyBuckets, ...overrides },
  });

  it("derives all four buckets from engine + scan state", () => {
    const view = deriveListView({
      loaded: [manifest("live", { tier: "core" })],
      engineDisabled: [{ manifest: manifest("failed"), reason: "Activation failed: boom" }],
      scan: scanOf({
        unchecked: [{ dir: "/plugins/fresh", manifest: manifest("fresh") }],
        disabledByOverride: [
          {
            dir: "/plugins/user-unloaded",
            manifest: manifest("user-unloaded"),
            record: { disabled: true, kind: "unloaded", reason: "unloaded by user" },
          },
          {
            dir: "/plugins/user-disabled",
            manifest: manifest("user-disabled"),
            record: { disabled: true, reason: "disabled by user" },
          },
        ],
        disabledWithReason: [
          {
            dir: "/plugins/depless",
            manifest: manifest("depless"),
            reason: 'Extension "depless" depends on "ghost", which is not loaded',
          },
        ],
        missing: [{ id: "gone", record: { disabled: true } }],
      }),
    });

    expect(view.loaded).toEqual([
      {
        id: "live",
        name: "Plugin live",
        version: "1.0.0",
        tier: "core",
        trust: "bundled",
        locked: true,
        dependsOn: [],
      },
    ]);
    // Engine-disabled entry first, then the scan refusal — deduped by id.
    expect(view.disabledWithReason.map((r) => r.id)).toEqual(["failed", "depless"]);
    // Discovered rows carry the override (kind distinguishes unload/disable);
    // fresh rows have no override (consent gate renders them unchecked).
    expect(view.discovered.map((r) => r.id)).toEqual(["fresh", "user-unloaded", "user-disabled"]);
    expect(view.discovered[0]?.override).toBeUndefined();
    expect(view.discovered[1]?.override).toMatchObject({ kind: "unloaded" });
    expect(view.discovered[2]?.override).toEqual({ reason: "disabled by user" });
    expect(view.missing).toEqual([{ id: "gone" }]);
  });

  it("folds apiVersion-incompatible scan entries into disabled-with-reason", () => {
    const view = deriveListView({
      loaded: [],
      engineDisabled: [],
      scan: scanOf({ unchecked: [] }, [
        {
          dir: "/plugins/old",
          kind: "incompatible",
          manifest: manifest("old"),
          reason: 'apiVersion "^9.0.0" is incompatible with kernel API 0.1.0',
        },
      ]),
    });
    expect(view.disabledWithReason).toHaveLength(1);
    expect(view.disabledWithReason[0]).toMatchObject({
      id: "old",
      reason: expect.stringContaining("incompatible"),
    });
  });

  it("never duplicates an id across engine and scan disabled entries", () => {
    const view = deriveListView({
      loaded: [],
      engineDisabled: [{ manifest: manifest("dup"), reason: "engine reason" }],
      scan: scanOf({
        disabledWithReason: [
          { dir: "/plugins/dup", manifest: manifest("dup"), reason: "scan reason" },
        ],
      }),
    });
    expect(view.disabledWithReason).toHaveLength(1);
    expect(view.disabledWithReason[0]?.reason).toBe("engine reason");
  });

  it("excludes broken-manifest directories (scan response is their surface)", () => {
    const view = deriveListView({
      loaded: [],
      engineDisabled: [],
      scan: scanOf({ unchecked: [] }, [
        { dir: "/plugins/broken", kind: "invalid", errors: ["no manifest"] },
      ]),
    });
    expect(view.discovered).toEqual([]);
    expect(view.disabledWithReason).toEqual([]);
  });

  it("never lists a loaded plugin as discovered", () => {
    const view = deriveListView({
      loaded: [manifest("live")],
      engineDisabled: [],
      scan: scanOf({
        unchecked: [{ dir: "/plugins/live", manifest: manifest("live") }],
      }),
    });
    expect(view.discovered).toEqual([]);
    expect(view.loaded.map((r) => r.id)).toEqual(["live"]);
  });
});

// ── deriveScanResponse ──────────────────────────────────────────────────────

describe("deriveScanResponse", () => {
  it("reports new plugins, invalid dirs, and incompatible manifests", () => {
    const response = deriveScanResponse(
      {
        scanned: [
          { dir: "/plugins/broken", kind: "invalid", errors: ["manifest.json not found"] },
          {
            dir: "/plugins/old",
            kind: "incompatible",
            manifest: manifest("old"),
            reason: "incompatible",
          },
        ],
        buckets: {
          ...emptyBuckets,
          unchecked: [{ dir: "/plugins/new", manifest: manifest("new") }],
        },
      },
      "/plugins",
    );
    expect(response.root).toBe("/plugins");
    expect(response.newPlugins.map((p) => p.id)).toEqual(["new"]);
    expect(response.invalid).toEqual([
      { dir: "/plugins/broken", errors: ["manifest.json not found"] },
    ]);
    expect(response.incompatible).toEqual([
      { dir: "/plugins/old", id: "old", reason: "incompatible" },
    ]);
  });
});

// ── classifyFrontendAccess (plan 03) ────────────────────────────────────────

describe("classifyFrontendAccess", () => {
  const dir = "/plugins/with-fe";
  const scanned = (id: string, extra: Partial<Manifest> = {}, entryDir = `/plugins/${id}`) => ({
    dir: entryDir,
    kind: "loadable" as const,
    manifest: manifest(id, extra),
  });

  it("allows a loaded, frontend-declaring, workspace-enabled plugin", () => {
    const verdict = classifyFrontendAccess({
      loaded: [manifest("with-fe", { frontend: { apiVersion: "^1", entry: "frontend.js" } })],
      scanned: [scanned("with-fe", { frontend: { apiVersion: "^1", entry: "frontend.js" } })],
      targetId: "with-fe",
      workspaceEnabled: true,
    });
    expect(verdict).toEqual({
      kind: "allowed",
      dir,
      entryPath: `${dir}/frontend.js`,
    });
  });

  it("blocks an id the scan has never seen as not-found", () => {
    const verdict = classifyFrontendAccess({
      loaded: [],
      scanned: [],
      targetId: "ghost",
      workspaceEnabled: true,
    });
    expect(verdict).toEqual({ kind: "blocked", reason: "not-found" });
  });

  it("blocks a scanned-but-unloaded plugin as not-loaded", () => {
    const verdict = classifyFrontendAccess({
      loaded: [],
      scanned: [scanned("unloaded")],
      targetId: "unloaded",
      workspaceEnabled: true,
    });
    expect(verdict).toEqual({ kind: "blocked", reason: "not-loaded" });
  });

  it("blocks a loaded plugin without a frontend section as no-frontend", () => {
    const verdict = classifyFrontendAccess({
      loaded: [manifest("plain")],
      scanned: [scanned("plain")],
      targetId: "plain",
      workspaceEnabled: true,
    });
    expect(verdict).toEqual({ kind: "blocked", reason: "no-frontend" });
  });

  it("blocks a workspace-disabled plugin (its code must not be fetchable)", () => {
    const verdict = classifyFrontendAccess({
      loaded: [manifest("with-fe", { frontend: { apiVersion: "^1", entry: "frontend.js" } })],
      scanned: [scanned("with-fe", { frontend: { apiVersion: "^1", entry: "frontend.js" } })],
      targetId: "with-fe",
      workspaceEnabled: false,
    });
    expect(verdict).toEqual({ kind: "blocked", reason: "workspace-disabled" });
  });

  it("rejects a traversal entry (../ escaping the plugin dir)", () => {
    const verdict = classifyFrontendAccess({
      loaded: [manifest("evil", { frontend: { apiVersion: "^1", entry: "../../evil.js" } })],
      scanned: [scanned("evil", { frontend: { apiVersion: "^1", entry: "../../evil.js" } })],
      targetId: "evil",
      workspaceEnabled: true,
    });
    expect(verdict).toEqual({ kind: "blocked", reason: "entry-escapes" });
  });

  it("rejects an absolute entry outside the plugin dir", () => {
    const verdict = classifyFrontendAccess({
      loaded: [manifest("abs", { frontend: { apiVersion: "^1", entry: "/etc/passwd" } })],
      scanned: [scanned("abs", { frontend: { apiVersion: "^1", entry: "/etc/passwd" } })],
      targetId: "abs",
      workspaceEnabled: true,
    });
    expect(verdict).toEqual({ kind: "blocked", reason: "entry-escapes" });
  });

  it("does not treat the target id as a path (dot-dot id is just not-found)", () => {
    const verdict = classifyFrontendAccess({
      loaded: [manifest("../..", { frontend: { apiVersion: "^1", entry: "x.js" } })],
      scanned: [scanned("../..", {}, "/etc")],
      targetId: "../../etc/passwd",
      workspaceEnabled: true,
    });
    expect(verdict).toEqual({ kind: "blocked", reason: "not-found" });
  });
});

// ── toLoadedRow + deriveListView: the additive frontend field (plan 03) ─────

describe("toLoadedRow — frontend field", () => {
  it("omits the frontend field when the manifest declares none", () => {
    const row = toLoadedRow(manifest("plain"));
    expect(row.frontend).toBeUndefined();
  });

  it("carries apiVersion + entry + bust when the entry is servable", () => {
    const row = toLoadedRow(
      manifest("fe", { frontend: { apiVersion: "^1", entry: "frontend.js" } }),
      new Map([["fe", "1727100000000"]]),
    );
    expect(row.frontend).toEqual({
      apiVersion: "^1",
      entry: "frontend.js",
      bust: "1727100000000",
    });
  });

  it("omits the field when the entry is NOT servable (no bust collected)", () => {
    const row = toLoadedRow(
      manifest("fe", { frontend: { apiVersion: "^1", entry: "frontend.js" } }),
    );
    expect(row.frontend).toBeUndefined();
  });
});

describe("deriveListView — frontend busts", () => {
  it("passes the bust map through to the loaded rows only", () => {
    const response = deriveListView({
      loaded: [
        manifest("fe", { frontend: { apiVersion: "^1", entry: "frontend.js" } }),
        manifest("plain"),
      ],
      engineDisabled: [],
      scan: { scanned: [], buckets: emptyBuckets },
      frontendBusts: new Map([["fe", "123"]]),
    });
    expect(response.loaded.find((r) => r.id === "fe")?.frontend?.bust).toBe("123");
    expect(response.loaded.find((r) => r.id === "plain")?.frontend).toBeUndefined();
  });
});
