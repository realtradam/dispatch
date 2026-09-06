import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DisabledExtension,
  Extension,
  LoadResult,
  Logger,
  Manifest,
  ReloadResult,
  StorageNamespace,
  UnloadResult,
} from "@dispatch/kernel";
import type { ExtensionsChangedMessage, PluginOpResponse } from "@dispatch/transport-contract";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginEngine,
  PluginScanResult,
  ReconciledScanBuckets,
  ScannedPluginEntry,
} from "./engine.js";
import type { PluginOverrideRecord } from "./overrides.js";
import { createPluginManagerService, type PluginManagerService } from "./service.js";

// ── Fakes (DI at the edge — never a mock of a Dispatch module) ──────────────

function fakeLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return fakeLogger();
    },
    span() {
      return {
        id: "fake-span",
        log: fakeLogger(),
        setAttributes() {},
        addLink() {},
        child() {
          return this;
        },
        end() {},
      };
    },
  };
}

/** In-memory StorageNamespace KV — the override store's shape, realized. */
function fakeStorage(initial: ReadonlyMap<string, string> = new Map()): StorageNamespace & {
  readonly data: Map<string, string>;
} {
  const data = new Map(initial);
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async has(key) {
      return data.has(key);
    },
    async keys() {
      return [...data.keys()];
    },
  };
}

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

interface FakeEngineOpts {
  readonly loaded?: readonly Manifest[];
  readonly disabled?: readonly DisabledExtension[];
  readonly scanned?: readonly ScannedPluginEntry[];
  readonly buckets?: Partial<ReconciledScanBuckets>;
  readonly loadResult?: (ext: Extension) => LoadResult;
  readonly unloadResult?: (id: string) => UnloadResult;
  readonly reloadResult?: (id: string, ext: Extension) => ReloadResult;
  readonly importUndefined?: boolean;
  /** Active agent turns for the stopAllAgents fake to report stopping. */
  readonly activeTurns?: number;
}

/** In-memory PluginEngine — records the calls the service makes. */
function fakeEngine(opts: FakeEngineOpts = {}) {
  const buckets: ReconciledScanBuckets = {
    unchecked: [],
    alreadyLoaded: [],
    disabledByOverride: [],
    disabledWithReason: [],
    missing: [],
    ...opts.buckets,
  };
  const loaded = [...(opts.loaded ?? [])];
  const calls = {
    load: [] as string[],
    unload: [] as { id: string; force: boolean }[],
    reload: [] as { id: string; force: boolean }[],
    imports: [] as string[],
    scans: 0,
  };
  const engine: PluginEngine = {
    getExtensions() {
      return [...loaded];
    },
    getDisabled() {
      return [...(opts.disabled ?? [])];
    },
    async loadExtension(ext) {
      calls.load.push(ext.manifest.id);
      loaded.push(ext.manifest);
      return opts.loadResult ? opts.loadResult(ext) : { ok: true, manifest: ext.manifest };
    },
    async unloadExtension(id, o) {
      calls.unload.push({ id, force: o?.force === true });
      const idx = loaded.findIndex((m) => m.id === id);
      if (idx >= 0) loaded.splice(idx, 1);
      return opts.unloadResult ? opts.unloadResult(id) : { ok: true, id, manifest: manifest(id) };
    },
    async reloadExtension(id, ext, o) {
      calls.reload.push({ id, force: o?.force === true });
      return opts.reloadResult
        ? opts.reloadResult(id, ext)
        : { ok: true, manifest: ext.manifest, reloadedDependents: undefined };
    },
    async scanPluginsDir() {
      calls.scans++;
      const result: PluginScanResult = {
        scanned: [...(opts.scanned ?? [])],
        buckets,
      };
      return result;
    },
    async importPluginEntry(entryPath) {
      calls.imports.push(entryPath);
      if (opts.importUndefined === true) return undefined;
      // Resolve the entry's manifest from the scan opts (a real import
      // evaluates the plugin's code; the fake reuses the scanned manifest).
      const entry = (opts.scanned ?? []).find((e) => e.entryPath === entryPath);
      return { manifest: entry?.manifest ?? manifest("imported") };
    },
    pluginsDir: "/plugins",
  };
  return { engine, calls };
}

interface ServiceHarness {
  readonly svc: PluginManagerService;
  readonly engine: ReturnType<typeof fakeEngine>;
  readonly storage: ReturnType<typeof fakeStorage>;
  readonly emits: ExtensionsChangedMessage[];
  readonly stopped: () => number;
}

function harness(
  opts: FakeEngineOpts & {
    readonly overrides?: Record<string, PluginOverrideRecord>;
    /** Per-workspace enablement (plan 03) — default: everything enabled. */
    readonly enabledInWorkspace?: (workspaceId: string | undefined, pluginId: string) => boolean;
  } = {},
): ServiceHarness {
  const e = fakeEngine(opts);
  const initial = new Map<string, string>();
  for (const [id, record] of Object.entries(opts.overrides ?? {})) {
    initial.set(id, JSON.stringify(record));
  }
  const storage = fakeStorage(initial);
  const emits: ExtensionsChangedMessage[] = [];
  let stopCalls = 0;
  const activeTurns = opts.activeTurns ?? 0;
  const svc = createPluginManagerService({
    engine: e.engine,
    storage,
    logger: fakeLogger(),
    now: () => "2026-09-02T00:00:00.000Z",
    emitExtensionsChanged: (message) => emits.push(message),
    stopAllAgents: () => {
      stopCalls++;
      return { stopped: activeTurns };
    },
    isPluginEnabledInWorkspace: async (workspaceId, pluginId) =>
      opts.enabledInWorkspace?.(workspaceId, pluginId) ?? true,
    readTextFile: (path) => readFile(path, "utf8").catch(() => null),
    statMtimeMs: async (path) => {
      try {
        return String((await stat(path)).mtimeMs);
      } catch {
        return null;
      }
    },
  });
  return { svc, engine: e, storage, emits, stopped: () => stopCalls };
}

// ── list ────────────────────────────────────────────────────────────────────

describe("PluginManagerService.list", () => {
  it("derives the view from the engine snapshot + a fresh scan", async () => {
    const h = harness({
      loaded: [manifest("live")],
      disabled: [{ manifest: manifest("failed"), reason: "Activation failed: boom" }],
      scanned: [
        {
          dir: "/plugins/fresh",
          kind: "loadable",
          manifest: manifest("fresh"),
          entryPath: "/plugins/fresh/index.ts",
        },
      ],
      buckets: {
        unchecked: [{ dir: "/plugins/fresh", manifest: manifest("fresh") }],
        disabledByOverride: [
          {
            dir: "/plugins/disabled",
            manifest: manifest("disabled"),
            record: { disabled: true, kind: "disabled", reason: "disabled by user" },
          },
        ],
        missing: [{ id: "gone", record: { disabled: true, reason: "deleted" } }],
      },
    });
    const view = await h.svc.list();
    expect(view.loaded.map((r) => r.id)).toEqual(["live"]);
    expect(view.disabledWithReason.map((r) => r.id)).toEqual(["failed"]);
    expect(view.discovered.map((r) => r.id)).toEqual(["fresh", "disabled"]);
    expect(view.missing).toEqual([{ id: "gone", reason: "deleted" }]);
  });
});

// ── scan ────────────────────────────────────────────────────────────────────

describe("PluginManagerService.scan", () => {
  it("never loads and emits the extensions-changed broadcast (§5, §11)", async () => {
    const h = harness({
      scanned: [
        { dir: "/plugins/new", kind: "loadable", manifest: manifest("new"), entryPath: "/x" },
      ],
      buckets: { unchecked: [{ dir: "/plugins/new", manifest: manifest("new") }] },
    });
    const response = await h.svc.scan();
    expect(response.newPlugins.map((p) => p.id)).toEqual(["new"]);
    expect(h.engine.calls.load).toEqual([]);
    expect(h.emits).toEqual([{ type: "extensions-changed", action: "scan" }]);
  });

  it("passes the OWNED override records to the scan (the store is read)", async () => {
    let seen: ReadonlyMap<string, PluginOverrideRecord> | undefined;
    const e = fakeEngine({});
    const svc = createPluginManagerService({
      engine: {
        ...e.engine,
        scanPluginsDir: async (overrides) => {
          seen = overrides;
          return e.engine.scanPluginsDir(overrides);
        },
      },
      storage: fakeStorage(new Map([["disabled-one", JSON.stringify({ disabled: true })]])),
      logger: fakeLogger(),
      now: () => "2026-09-02T00:00:00.000Z",
      emitExtensionsChanged: () => {},
      stopAllAgents: () => ({ stopped: 0 }),
    });
    await svc.scan();
    expect(seen?.get("disabled-one")).toEqual({ disabled: true });
  });
});

// ── load ────────────────────────────────────────────────────────────────────

describe("PluginManagerService.load", () => {
  it("imports + engine-loads the discovered plugin and emits the change", async () => {
    const h = harness({
      scanned: [
        {
          dir: "/plugins/new",
          kind: "loadable",
          manifest: manifest("new"),
          entryPath: "/plugins/new/index.ts",
        },
      ],
    });
    const result = await h.svc.load("new");
    expect(result).toEqual({ ok: true, action: "load", id: "new" });
    expect(h.engine.calls.imports).toEqual(["/plugins/new/index.ts"]);
    expect(h.engine.calls.load).toEqual(["new"]);
    expect(h.emits).toEqual([{ type: "extensions-changed", action: "load", pluginId: "new" }]);
  });

  it("clears the override record (consent — boot default-on afterwards)", async () => {
    const h = harness({
      overrides: { "new": { disabled: true, reason: "disabled by user" } },
      scanned: [
        { dir: "/plugins/new", kind: "loadable", manifest: manifest("new"), entryPath: "/x" },
      ],
    });
    const result = (await h.svc.load("new")) as Extract<PluginOpResponse, { ok: true }>;
    expect(result.clearedOverride).toBe(true);
    expect(h.storage.data.has("new")).toBe(false);
  });

  it("blocks with already-loaded when the plugin is live", async () => {
    const h = harness({ loaded: [manifest("live")] });
    const result = await h.svc.load("live");
    expect(result).toMatchObject({ ok: false, reason: "already-loaded" });
    expect(h.engine.calls.load).toEqual([]);
  });

  it("blocks with not-found when no loadable entry has the id", async () => {
    const h = harness({ scanned: [{ dir: "/plugins/a", kind: "invalid", errors: ["bad"] }] });
    const result = await h.svc.load("a");
    expect(result).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("blocks with engine-refused when the engine refuses the load", async () => {
    const h = harness({
      scanned: [
        { dir: "/plugins/new", kind: "loadable", manifest: manifest("new"), entryPath: "/x" },
      ],
      loadResult: () => ({ ok: false, reason: "unmet dependencies" }),
    });
    const result = await h.svc.load("new");
    expect(result).toMatchObject({
      ok: false,
      reason: "engine-refused",
      message: "unmet dependencies",
    });
  });

  it("blocks with engine-refused when the import fails", async () => {
    const h = harness({
      scanned: [
        { dir: "/plugins/new", kind: "loadable", manifest: manifest("new"), entryPath: "/x" },
      ],
      importUndefined: true,
    });
    const result = await h.svc.load("new");
    expect(result).toMatchObject({ ok: false, reason: "engine-refused" });
    expect(h.engine.calls.load).toEqual([]);
  });
});

// ── unload (§8 policy enforcement) ──────────────────────────────────────────

describe("PluginManagerService.unload", () => {
  it("writes an unload override record so boot keeps it unloaded", async () => {
    const h = harness({ loaded: [manifest("a")] });
    const result = await h.svc.unload("a");
    expect(result).toEqual({ ok: true, action: "unload", id: "a" });
    expect(h.storage.data.get("a")).toBe(
      JSON.stringify({
        disabled: true,
        kind: "unloaded",
        reason: "unloaded by user",
        disabledAt: "2026-09-02T00:00:00.000Z",
      }),
    );
    expect(h.emits).toEqual([{ type: "extensions-changed", action: "unload", pluginId: "a" }]);
  });

  it("refuses core plugins and never calls the engine", async () => {
    const h = harness({ loaded: [manifest("plugin-manager", { tier: "core" })] });
    const result = await h.svc.unload("plugin-manager");
    expect(result).toMatchObject({ ok: false, reason: "core-locked" });
    expect(h.engine.calls.unload).toEqual([]);
    expect(h.emits).toEqual([]);
  });

  it("refuses the LAST provider (hard lock — force cannot override)", async () => {
    const h = harness({ loaded: [manifest("only-provider", { tier: "providers" })] });
    const result = await h.svc.unload("only-provider", { force: true });
    expect(result).toMatchObject({ ok: false, reason: "last-provider" });
    expect(h.engine.calls.unload).toEqual([]);
  });

  it("without force, blocks with the cascade and does NOT stop agents", async () => {
    const h = harness({
      loaded: [manifest("a"), manifest("b", { dependsOn: ["a"] })],
    });
    const result = await h.svc.unload("a");
    expect(result).toMatchObject({
      ok: false,
      reason: "cascade-needs-force",
      dependents: ["b"],
    });
    expect(h.stopped()).toBe(0);
    expect(h.engine.calls.unload).toEqual([]);
  });

  it("with force: stops ALL agents first, unloads dependents reverse-topologically, then the target", async () => {
    const h = harness({
      loaded: [
        manifest("a"),
        manifest("b", { dependsOn: ["a"] }),
        manifest("c", { dependsOn: ["b"] }),
      ],
      activeTurns: 2,
    });
    const result = (await h.svc.unload("a", { force: true })) as Extract<
      PluginOpResponse,
      { ok: true }
    >;
    // Reverse topological: leaf dependent c before b, target a last.
    expect(h.engine.calls.unload.map((u) => u.id)).toEqual(["c", "b", "a"]);
    expect(result.cascade).toEqual(["c", "b"]);
    expect(result.stoppedAgents).toBe(2);
    expect(h.stopped()).toBe(1);
  });

  it("with force and NO dependents still stops agents (in-use semantics)", async () => {
    const h = harness({ loaded: [manifest("a"), manifest("b")] });
    await h.svc.unload("a", { force: true });
    expect(h.stopped()).toBe(1);
    expect(h.engine.calls.unload.map((u) => u.id)).toEqual(["a"]);
  });

  it("force with no agents active reports zero stopped", async () => {
    const h = harness({ loaded: [manifest("a")], activeTurns: 0 });
    const result = (await h.svc.unload("a", { force: true })) as Extract<
      PluginOpResponse,
      { ok: true }
    >;
    expect(result.stoppedAgents).toBeUndefined();
    expect(h.stopped()).toBe(1); // stopAllAgents WAS called; it stopped 0 turns
  });

  it("force stops ALL agents — the count reflects the orchestrator's report", async () => {
    const h = harness({ loaded: [manifest("a"), manifest("b")], activeTurns: 3 });
    const result = (await h.svc.unload("b", { force: true })) as Extract<
      PluginOpResponse,
      { ok: true }
    >;
    expect(result.stoppedAgents).toBe(3);
  });

  it("aborts the target unload when a cascade member fails (never strand a dependent)", async () => {
    const h = harness({
      loaded: [manifest("a"), manifest("b", { dependsOn: ["a"] })],
      unloadResult: (id) =>
        id === "b" ? { ok: false, id, reason: "deactivate blew up" } : { ok: true, id },
    });
    const result = await h.svc.unload("a", { force: true });
    expect(result).toMatchObject({
      ok: false,
      reason: "engine-refused",
      dependents: [], // nothing had succeeded yet
    });
    // The target was NOT unloaded.
    expect(h.engine.calls.unload.map((u) => u.id)).toEqual(["b"]);
    expect(h.storage.data.has("a")).toBe(false);
  });
});

// ── reload ──────────────────────────────────────────────────────────────────

describe("PluginManagerService.reload", () => {
  it("imports a fresh instance and reloads without force when no dependents", async () => {
    const h = harness({
      loaded: [manifest("a")],
      scanned: [
        {
          dir: "/plugins/a",
          kind: "loadable",
          manifest: manifest("a"),
          entryPath: "/plugins/a/index.ts",
        },
      ],
    });
    const result = await h.svc.reload("a");
    expect(result).toEqual({ ok: true, action: "reload", id: "a" });
    expect(h.engine.calls.reload).toEqual([{ id: "a", force: false }]);
    expect(h.engine.calls.imports).toEqual(["/plugins/a/index.ts"]);
    expect(h.stopped()).toBe(0);
    expect(h.emits).toEqual([{ type: "extensions-changed", action: "reload", pluginId: "a" }]);
  });

  it("without force, blocks on loaded dependents", async () => {
    const h = harness({
      loaded: [manifest("a"), manifest("b", { dependsOn: ["a"] })],
      scanned: [{ dir: "/plugins/a", kind: "loadable", manifest: manifest("a"), entryPath: "/x" }],
    });
    const result = await h.svc.reload("a");
    expect(result).toMatchObject({ ok: false, reason: "cascade-needs-force", dependents: ["b"] });
    expect(h.engine.calls.reload).toEqual([]);
  });

  it("with force: stops agents and passes force to the engine (it cascades)", async () => {
    const h = harness({
      loaded: [manifest("a"), manifest("b", { dependsOn: ["a"] })],
      scanned: [{ dir: "/plugins/a", kind: "loadable", manifest: manifest("a"), entryPath: "/x" }],
      reloadResult: () => ({
        ok: true,
        manifest: manifest("a"),
        unloadedDependents: ["b"],
        reloadedDependents: ["b"],
      }),
      activeTurns: 1,
    });
    const result = await h.svc.reload("a", { force: true });
    expect(result).toEqual({
      ok: true,
      action: "reload",
      id: "a",
      unloadedDependents: ["b"],
      reloadedDependents: ["b"],
      stoppedAgents: 1,
    });
    expect(h.stopped()).toBe(1);
  });

  it("blocks not-found for a loaded plugin whose directory is gone", async () => {
    const h = harness({ loaded: [manifest("a")] });
    const result = await h.svc.reload("a");
    expect(result).toMatchObject({ ok: false, reason: "not-found" });
  });
});

// ── forget ──────────────────────────────────────────────────────────────────

describe("PluginManagerService.forget", () => {
  it("clears a saved override record (§6 — unchecked clears the record)", async () => {
    const h = harness({ overrides: { gone: { disabled: true, reason: "unloaded by user" } } });
    const result = await h.svc.forget("gone");
    expect(result).toEqual({ ok: true, action: "forget", id: "gone", clearedOverride: true });
    expect(h.storage.data.has("gone")).toBe(false);
    expect(h.emits).toEqual([{ type: "extensions-changed", action: "forget", pluginId: "gone" }]);
  });

  it("is idempotent — forgetting a plugin without a record succeeds", async () => {
    const h = harness();
    const result = await h.svc.forget("ghost");
    expect(result).toEqual({ ok: true, action: "forget", id: "ghost", clearedOverride: false });
  });
});

// ── frontendEntry (plan 03) ─────────────────────────────────────────────────

describe("PluginManagerService.frontendEntry", () => {
  /** A REAL temp plugin dir — the served bytes must be the file's bytes. */
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function tempPlugin(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "plugin-fe-"));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      const file = join(dir, name);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, content, "utf8");
    }
    return dir;
  }

  const feManifest = (id: string, entry = "frontend.js"): Manifest =>
    manifest(id, { frontend: { apiVersion: "^1", entry } });

  it("serves the entry file's exact bytes + its mtime bust", async () => {
    const dir = await tempPlugin({ "frontend.js": "export default 1;\n" });
    const h = harness({
      loaded: [feManifest("fe")],
      scanned: [{ dir, kind: "loadable", manifest: feManifest("fe") }],
    });
    const result = await h.svc.frontendEntry("fe", "team-a");
    expect(result).toEqual({ ok: true, code: "export default 1;\n", bust: expect.any(String) });
    if (result.ok) expect(Number(result.bust)).not.toBeNaN();
  });

  it("404-matrix: unknown id → not-found", async () => {
    const h = harness({ loaded: [], scanned: [] });
    expect(await h.svc.frontendEntry("ghost", "w")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("404-matrix: scanned but not loaded → not-loaded", async () => {
    const h = harness({
      loaded: [],
      scanned: [{ dir: "/plugins/fe", kind: "loadable", manifest: feManifest("fe") }],
    });
    expect(await h.svc.frontendEntry("fe", "w")).toEqual({ ok: false, reason: "not-loaded" });
  });

  it("404-matrix: loaded without a frontend section → no-frontend", async () => {
    const h = harness({
      loaded: [manifest("plain")],
      scanned: [{ dir: "/plugins/plain", kind: "loadable", manifest: manifest("plain") }],
    });
    expect(await h.svc.frontendEntry("plain", "w")).toEqual({
      ok: false,
      reason: "no-frontend",
    });
  });

  it("404-matrix: disabled in the caller's active workspace → workspace-disabled", async () => {
    const dir = await tempPlugin({ "frontend.js": "export default 1;\n" });
    const h = harness({
      loaded: [feManifest("fe")],
      scanned: [{ dir, kind: "loadable", manifest: feManifest("fe") }],
      enabledInWorkspace: (_ws, id) => id !== "fe",
    });
    expect(await h.svc.frontendEntry("fe", "team-a")).toEqual({
      ok: false,
      reason: "workspace-disabled",
    });
  });

  it("404-matrix: traversal entry → entry-escapes (never serves outside the dir)", async () => {
    const dir = await tempPlugin({});
    await mkdir(join(dir, "sub"), { recursive: true });
    const h = harness({
      loaded: [feManifest("evil", "../../outside.js")],
      scanned: [{ dir, kind: "loadable", manifest: feManifest("evil", "../../outside.js") }],
    });
    expect(await h.svc.frontendEntry("evil", "w")).toEqual({
      ok: false,
      reason: "entry-escapes",
    });
  });

  it("resolves a subdirectory entry INSIDE the plugin dir", async () => {
    const dir = await tempPlugin({ "dist/frontend.js": "export const v = 2;\n" });
    const h = harness({
      loaded: [feManifest("fe", "dist/frontend.js")],
      scanned: [{ dir, kind: "loadable", manifest: feManifest("fe", "dist/frontend.js") }],
    });
    const result = await h.svc.frontendEntry("fe", "w");
    expect(result).toEqual({ ok: true, code: "export const v = 2;\n", bust: expect.any(String) });
  });

  it("absent workspace id falls through to the enablement check (default-workspace resolution)", async () => {
    const dir = await tempPlugin({ "frontend.js": "x" });
    const h = harness({
      loaded: [feManifest("fe")],
      scanned: [{ dir, kind: "loadable", manifest: feManifest("fe") }],
      enabledInWorkspace: (ws) => ws === undefined,
    });
    expect(await h.svc.frontendEntry("fe")).toEqual({
      ok: true,
      code: "x",
      bust: expect.any(String),
    });
    expect(await h.svc.frontendEntry("fe", "team-a")).toEqual({
      ok: false,
      reason: "workspace-disabled",
    });
  });

  it("list() carries the additive frontend field for servable entries only", async () => {
    const dir = await tempPlugin({ "frontend.js": "x", "missing.js": "y" });
    const h = harness({
      loaded: [
        feManifest("fe"),
        manifest("plain"),
        manifest("broken", { frontend: { apiVersion: "^1", entry: "nope.js" } }),
      ],
      scanned: [
        { dir, kind: "loadable", manifest: feManifest("fe") },
        { dir, kind: "loadable", manifest: manifest("plain") },
        {
          dir,
          kind: "loadable",
          manifest: manifest("broken", { frontend: { apiVersion: "^1", entry: "nope.js" } }),
        },
      ],
    });
    const view = await h.svc.list();
    const fe = view.loaded.find((r) => r.id === "fe");
    expect(fe?.frontend).toEqual({
      apiVersion: "^1",
      entry: "frontend.js",
      bust: expect.any(String),
    });
    expect(view.loaded.find((r) => r.id === "plain")?.frontend).toBeUndefined();
    expect(view.loaded.find((r) => r.id === "broken")?.frontend).toBeUndefined();
  });
});
