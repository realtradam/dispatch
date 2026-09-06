/**
 * The PluginManagerService — the thin effect shell around the pure decision
 * core (pure.ts). Each operation: read the override store, snapshot the
 * engine state, consult the pure verdict, apply it via the injected effects
 * (engine calls, storage writes, agent stop, event emit), and map the
 * outcome to a structured result the HTTP layer maps to statuses.
 *
 * Every effect is injected (AGENTS.md: effects live at the edges) — tests
 * drive this service with a fake engine + in-memory store, never a mock of
 * a Dispatch module.
 */

import * as path from "node:path";
import type { Logger, Manifest, PluginTier, StorageNamespace } from "@dispatch/kernel";
import type {
  PluginAction,
  PluginBlockReason,
  PluginListResponse,
  PluginOpResponse,
  PluginScanResponse,
} from "@dispatch/transport-contract";
import type { PluginEngine, PluginScanResult } from "./engine.js";
import {
  decodeOverrideRecord,
  encodeOverrideRecord,
  type PluginOverrideRecord,
} from "./overrides.js";
import {
  classifyFrontendAccess,
  classifyReload,
  classifyUnload,
  deriveListView,
  deriveScanResponse,
  findLoadableEntry,
  overrideForUnload,
} from "./pure.js";

export interface PluginManagerServiceDeps {
  /** The host engine + discovery machinery (provided by the composition root). */
  readonly engine: PluginEngine;
  /** The override-record store (`plugin-overrides` KV namespace) — OWNED here. */
  readonly storage: StorageNamespace;
  readonly logger: Logger;
  /** ISO timestamp source for override records (injected clock). */
  readonly now: () => string;
  /** The multi-client change broadcast (§11) — fired after every mutation. */
  readonly emitExtensionsChanged: (message: {
    readonly type: "extensions-changed";
    readonly action: "load" | "unload" | "reload" | "scan" | "forget";
    readonly pluginId?: string;
  }) => void;
  /**
   * Stop ALL agents globally (§8 — forced unloads/reloads of in-use plugins;
   * the per-plugin attribution question is plan-00 question 2: global by
   * design). Partial turns persist per the durability rule.
   */
  readonly stopAllAgents: () => { readonly stopped: number };
  /**
   * Per-workspace enablement check (plan 03) — is `pluginId` usable in
   * `workspaceId`, given its loaded tier? Implemented by the extension from
   * the workspace-plugin-config service (`stateOf` + `isPluginUsable`,
   * fail-open when that service is absent — the usable.ts philosophy).
   * `workspaceId` may be `undefined` (the route's query param is optional);
   * the implementation resolves that to the default workspace.
   */
  readonly isPluginEnabledInWorkspace: (
    workspaceId: string | undefined,
    pluginId: string,
    tier: PluginTier,
  ) => Promise<boolean>;
  /**
   * Read a text file (plan 03 frontend entry) — the ONLY file I/O the
   * manager does; injected so the service stays an effect shell.
   * `null` on any read failure (missing/unreadable file).
   */
  readonly readTextFile: (path: string) => Promise<string | null>;
  /**
   * The entry file's mtimeMs (plan 03 cache-bust version — the SAME value
   * the backend loader uses as its `?v=` query). `null` on stat failure.
   */
  readonly statMtimeMs: (path: string) => Promise<string | null>;
}

/** Outcome of `frontendEntry` (the HTTP route maps it to a status). */
export type FrontendEntryResult =
  | { readonly ok: true; readonly code: string; readonly bust: string }
  | { readonly ok: false; readonly reason: string };

export interface PluginManagerService {
  /** The manager view: loaded + disabled-with-reason + discovered + missing. */
  list(): Promise<PluginListResponse>;
  /**
   * Run a scan (manual scan control — no fs watcher in v1, §5) and report
   * what changed. NEVER auto-loads: new discoveries are consent-gated
   * (unchecked) until an explicit load.
   */
  scan(): Promise<PluginScanResponse>;
  /** Load a discovered plugin (deletes any override record — consent). */
  load(id: string): Promise<PluginOpResponse>;
  /** Unload a loaded plugin (§8 policy: core lock, last-provider lock, cascade). */
  unload(id: string, opts?: { readonly force?: boolean }): Promise<PluginOpResponse>;
  /** Reload a loaded plugin's code (engine cascade applies with `force`). */
  reload(id: string, opts?: { readonly force?: boolean }): Promise<PluginOpResponse>;
  /**
   * Clear a plugin's saved override record — the "unchecked clears the
   * record" action for greyed-out missing rows (§6; the record survives so
   * the user notices, and forgetting it acknowledges the plugin is gone).
   */
  forget(id: string): Promise<PluginOpResponse>;
  /**
   * Serve a loaded plugin's frontend entry file (plan 03 §3.1) — the exact
   * bytes of `manifest.frontend.entry`, with the cache-bust version (the
   * entry's mtimeMs, the loader's `?v=`). Blocked (404 at the route) when
   * the plugin is unknown/unloaded/frontend-less/disabled in the caller's
   * active workspace, or when the entry escapes the plugin directory.
   * `workspaceId` is the requesting client's ACTIVE workspace (optional —
   * resolved to the default workspace when absent).
   */
  frontendEntry(id: string, workspaceId?: string): Promise<FrontendEntryResult>;
}

function blocked(
  action: PluginAction,
  id: string,
  reason: PluginBlockReason,
  message: string,
  dependents?: readonly string[],
): PluginOpResponse {
  return {
    ok: false,
    action,
    id,
    reason,
    message,
    ...(dependents !== undefined ? { dependents } : {}),
  };
}

export function createPluginManagerService(deps: PluginManagerServiceDeps): PluginManagerService {
  const { engine, storage, logger } = deps;

  /** Read the owned override store — log-and-skip unparsable records. */
  async function readOverrides(): Promise<Map<string, PluginOverrideRecord>> {
    const overrides = new Map<string, PluginOverrideRecord>();
    for (const key of await storage.keys()) {
      const raw = await storage.get(key);
      if (raw === null) continue;
      const record = decodeOverrideRecord(raw);
      if (record !== undefined) {
        overrides.set(key, record);
      } else {
        logger.warn(`plugin-overrides: ignoring unparsable record for "${key}"`);
      }
    }
    return overrides;
  }

  /** Delete an override record; true when one existed. */
  async function clearOverride(id: string): Promise<boolean> {
    const existing = await storage.get(id);
    if (existing === null) return false;
    await storage.delete(id);
    return true;
  }

  /** One scan pass against the current override contents. */
  async function scanNow(): Promise<PluginScanResult> {
    const overrides = await readOverrides();
    return engine.scanPluginsDir(overrides);
  }

  /**
   * Cache-bust values (entry mtimeMs) for every LOADED plugin that declares
   * a frontend section and whose entry file resolves on disk (plan 03). The
   * additive `GET /plugins` field carries these so clients can build
   * content-versioned import URLs.
   */
  async function frontendBusts(
    loaded: readonly Manifest[],
    scan: PluginScanResult,
  ): Promise<Map<string, string>> {
    const dirs = new Map(
      scan.scanned.flatMap((e) =>
        e.kind === "loadable" && e.manifest !== undefined ? [[e.manifest.id, e.dir] as const] : [],
      ),
    );
    const busts = new Map<string, string>();
    for (const manifest of loaded) {
      if (manifest.frontend === undefined) continue;
      const dir = dirs.get(manifest.id);
      if (dir === undefined) continue; // bundled / dir gone — not servable
      const entryPath = path.resolve(dir, manifest.frontend.entry);
      const rel = path.relative(dir, entryPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // traversal — not servable
      const bust = await deps.statMtimeMs(entryPath);
      if (bust !== null) busts.set(manifest.id, bust);
    }
    return busts;
  }

  return {
    async list() {
      const scan = await scanNow();
      return deriveListView({
        loaded: engine.getExtensions(),
        engineDisabled: engine
          .getDisabled()
          .map((d) => ({ manifest: d.manifest, reason: d.reason })),
        scan,
        ...(await (async () => {
          const busts = await frontendBusts(engine.getExtensions(), scan);
          return busts.size > 0 ? { frontendBusts: busts } : {};
        })()),
      });
    },

    async frontendEntry(id, workspaceId) {
      const [scan, loaded] = [await scanNow(), engine.getExtensions()];
      const manifest = loaded.find((m) => m.id === id);
      const verdict = classifyFrontendAccess({
        loaded,
        scanned: scan.scanned,
        targetId: id,
        workspaceEnabled:
          manifest === undefined
            ? false
            : await deps.isPluginEnabledInWorkspace(workspaceId, id, manifest.tier),
      });
      if (verdict.kind === "blocked") {
        // All reasons map to 404 at the route — the reason is for the LOG
        // only (it must not leak which case hit to the client).
        logger.warn(`plugin-manager: frontend entry for "${id}" blocked: ${verdict.reason}`);
        return { ok: false, reason: verdict.reason };
      }
      const bust = await deps.statMtimeMs(verdict.entryPath);
      if (bust === null) {
        logger.warn(`plugin-manager: frontend entry for "${id}" unreadable`);
        return { ok: false, reason: "unreadable" };
      }
      const code = await deps.readTextFile(verdict.entryPath);
      if (code === null) {
        logger.warn(`plugin-manager: frontend entry for "${id}" read failed`);
        return { ok: false, reason: "unreadable" };
      }
      return { ok: true, code, bust };
    },

    async scan() {
      const scan = await scanNow();
      const response = deriveScanResponse(scan, engine.pluginsDir);
      // §11 — all frontends refresh (the discovered set is the scan's product).
      deps.emitExtensionsChanged({ type: "extensions-changed", action: "scan" });
      return response;
    },

    async load(id) {
      const scan = await scanNow();
      const loadedIds = new Set(engine.getExtensions().map((m) => m.id));
      if (loadedIds.has(id)) {
        return blocked(
          "load",
          id,
          "already-loaded",
          `Plugin "${id}" is already loaded — use reload to replace it`,
        );
      }
      const entry = findLoadableEntry(scan.scanned, id);
      if (entry === undefined || entry.manifest === undefined || entry.entryPath === undefined) {
        return blocked(
          "load",
          id,
          "not-found",
          `No loadable plugin "${id}" found in ${engine.pluginsDir} — run a scan to discover plugins`,
        );
      }
      // Consent: the override record goes BEFORE the engine call — a failed
      // load lands in disabled-with-reason (the real reason), and the user's
      // consent to load persists across a partial outcome.
      const clearedOverride = await clearOverride(id);
      const ext = await engine.importPluginEntry(entry.entryPath);
      if (ext === undefined) {
        return blocked(
          "load",
          id,
          "engine-refused",
          `Plugin "${id}" failed to import — see server logs`,
        );
      }
      const result = await engine.loadExtension(ext);
      if (!result.ok) {
        return blocked(
          "load",
          id,
          "engine-refused",
          result.reason ?? `Plugin "${id}" failed to load`,
        );
      }
      logger.info(`plugin-manager: loaded "${id}"`);
      deps.emitExtensionsChanged({ type: "extensions-changed", action: "load", pluginId: id });
      return {
        ok: true,
        action: "load",
        id,
        ...(clearedOverride ? { clearedOverride } : {}),
      };
    },

    async unload(id, opts) {
      const force = opts?.force === true;
      const loaded = engine.getExtensions();
      const decision = classifyUnload({ loaded, targetId: id, force });
      if (decision.kind === "blocked") {
        return blocked("unload", id, decision.reason, decision.message, decision.dependents);
      }
      // §8 — the swap lands immediately: ALL agents stop before the first
      // engine call (partial turns persist per the durability rule).
      const stoppedAgents = decision.stopAgents ? deps.stopAllAgents().stopped : 0;

      // Cascade: dependents first (reverse-topological — the decision's
      // order). A failed cascade member ABORTS the target unload (never
      // leave a loaded plugin with its dependency gone).
      const unloaded: string[] = [];
      for (const depId of decision.cascade) {
        const r = await engine.unloadExtension(depId, { force: true });
        if (r.ok) {
          unloaded.push(depId);
        } else {
          logger.warn(
            `plugin-manager: cascade unload of "${depId}" failed: ${r.reason ?? "unknown"}`,
          );
          return blocked(
            "unload",
            id,
            "engine-refused",
            `Cascade unload of dependent "${depId}" failed: ${r.reason ?? "unknown"} — target not unloaded`,
            unloaded,
          );
        }
      }
      const result = await engine.unloadExtension(id, { force: true });
      if (!result.ok) {
        return blocked(
          "unload",
          id,
          "engine-refused",
          result.reason ?? `Plugin "${id}" failed to unload`,
          unloaded.length > 0 ? unloaded : undefined,
        );
      }
      await storage.set(id, encodeOverrideRecord(overrideForUnload(deps.now())));
      logger.info(
        `plugin-manager: unloaded "${id}"${unloaded.length > 0 ? ` (cascade: ${unloaded.join(", ")})` : ""}`,
      );
      deps.emitExtensionsChanged({ type: "extensions-changed", action: "unload", pluginId: id });
      return {
        ok: true,
        action: "unload",
        id,
        ...(unloaded.length > 0 ? { cascade: unloaded } : {}),
        ...(stoppedAgents > 0 ? { stoppedAgents } : {}),
      };
    },

    async reload(id, opts) {
      const force = opts?.force === true;
      const loaded = engine.getExtensions();
      const decision = classifyReload({ loaded, targetId: id, force });
      if (decision.kind === "blocked") {
        return blocked("reload", id, decision.reason, decision.message, decision.dependents);
      }
      const stoppedAgents = decision.stopAgents ? deps.stopAllAgents().stopped : 0;

      const scan = await scanNow();
      const entry = findLoadableEntry(scan.scanned, id);
      const stillLoaded = loaded.some((m) => m.id === id);
      if (entry === undefined || entry.manifest === undefined || entry.entryPath === undefined) {
        return blocked(
          "reload",
          id,
          "not-found",
          stillLoaded
            ? `Plugin "${id}" is loaded but its directory is gone from ${engine.pluginsDir} — it cannot be reloaded`
            : `No loadable plugin "${id}" found in ${engine.pluginsDir} — run a scan to discover plugins`,
        );
      }
      // Reload is consent to run this code now — a stale disable-record
      // (which would otherwise keep it unloaded next boot) is cleared.
      const clearedOverride = await clearOverride(id);
      const ext = await engine.importPluginEntry(entry.entryPath);
      if (ext === undefined) {
        return blocked(
          "reload",
          id,
          "engine-refused",
          `Plugin "${id}" failed to import — see server logs`,
        );
      }
      const result = await engine.reloadExtension(id, ext, force ? { force: true } : undefined);
      if (!result.ok) {
        return blocked(
          "reload",
          id,
          "engine-refused",
          result.reason ?? `Plugin "${id}" failed to reload`,
        );
      }
      logger.info(`plugin-manager: reloaded "${id}"`);
      deps.emitExtensionsChanged({ type: "extensions-changed", action: "reload", pluginId: id });
      return {
        ok: true,
        action: "reload",
        id,
        ...(result.unloadedDependents !== undefined
          ? { unloadedDependents: result.unloadedDependents }
          : {}),
        ...(result.reloadedDependents !== undefined
          ? { reloadedDependents: result.reloadedDependents }
          : {}),
        ...(clearedOverride ? { clearedOverride } : {}),
        ...(stoppedAgents > 0 ? { stoppedAgents } : {}),
      };
    },

    async forget(id) {
      const existed = await clearOverride(id);
      logger.info(`plugin-manager: ${existed ? "cleared" : "no"} override record for "${id}"`);
      deps.emitExtensionsChanged({ type: "extensions-changed", action: "forget", pluginId: id });
      return { ok: true, action: "forget", id, clearedOverride: existed };
    },
  };
}
