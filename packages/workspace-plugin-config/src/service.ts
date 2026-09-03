/**
 * The WorkspacePluginConfigService — the thin effect shell around the pure
 * decision core (pure.ts). It OWNS the per-workspace plugin state store
 * (§12 — nothing else writes it) and exposes:
 *
 * - `stateOf` / `effectiveStates` — the ENFORCEMENT reads (tool gate,
 *   model gate, surface filter). Each read is read-through: the first read
 *   of a workspace materializes its inherited records (§6.1).
 * - `view` — the workspace modal's per-plugin rows (state + loaded/locked
 *   metadata, §6.6).
 * - `enabledProviderCount` — the zero-enabled-providers guardrail signal
 *   (§6.5).
 * - `setState` — set/clear one workspace's state for one plugin, refusing
 *   unloaded/core plugins (strict layering, §7).
 *
 * Every effect is injected (AGENTS.md: effects live at the edges) — tests
 * drive this service with an in-memory store, never a mock of a Dispatch
 * module.
 */

import type { Logger, PluginTier, StorageNamespace } from "@dispatch/kernel";
import type { WorkspacePluginRow } from "@dispatch/transport-contract";
import {
  type CatalogPlugin,
  DEFAULT_WORKSPACE_ID,
  decodeStateRecord,
  encodeStateRecord,
  isPluginUsable,
  type MaterializationWrite,
  materializedMarkerKey,
  planMaterialization,
  type SetStateValidation,
  storageKey,
  validateSetState,
  WORKSPACE_PLUGIN_CONFIG_NAMESPACE,
  type WorkspacePluginState,
} from "./pure.js";

export { DEFAULT_WORKSPACE_ID, WORKSPACE_PLUGIN_CONFIG_NAMESPACE };

/** The request body state for `PUT /workspaces/:id/plugins/:pluginId`. */
export type SetWorkspaceStateRequest = "enabled" | "disabled" | "unset";

/** Refusal reasons for `setState` (HTTP 409 — see the route docs). */
export type SetStateRefusalReason = Extract<SetStateValidation, { ok: false }>["reason"];

export type SetWorkspaceStateResult =
  | { readonly ok: true; readonly state: WorkspacePluginState }
  | { readonly ok: false; readonly reason: SetStateRefusalReason };

/** One stored record: the state plus the tier stamped at write time. */
interface StoredRecord {
  readonly state: "enabled" | "disabled";
  readonly tier?: PluginTier;
}

export interface WorkspacePluginConfigDeps {
  /** The owned `workspace-plugin-config` KV namespace (injected). */
  readonly storage: StorageNamespace;
  /**
   * The currently-LOADED plugins (live view over the host's loaded
   * manifests — id + tier). Injected by the extension from
   * `host.getExtensions()`; read per call so mid-session loads/unloads are
   * seen on the next read.
   */
  readonly getPlugins: () => readonly CatalogPlugin[];
  readonly logger: Logger;
}

export interface WorkspacePluginConfigService {
  /**
   * ENFORCEMENT read — the effective per-workspace state for one plugin
   * (`undefined` = no record / blank slate). Read-through: materializes
   * the workspace on first read (§6.1).
   */
  readonly stateOf: (workspaceId: string, pluginId: string) => Promise<WorkspacePluginState>;
  /**
   * ENFORCEMENT read — every RECORDED state for a workspace (read-through).
   * Plugins absent from the map are `undefined` (blank slate).
   */
  readonly effectiveStates: (
    workspaceId: string,
  ) => Promise<ReadonlyMap<string, WorkspacePluginState>>;
  /**
   * The workspace modal's view (§6.6): one row per LOADED plugin
   * (materialized; unrecorded → `"undefined"`) plus any plugin with a
   * stored record whose plugin is not currently loaded (the modal greys
   * it), with `locked` (tier core) and `loaded` metadata, and the
   * `enabledProviderCount` guardrail signal. Read-through.
   */
  readonly view: (workspaceId: string) => Promise<{
    readonly plugins: readonly WorkspacePluginRow[];
    readonly enabledProviderCount: number;
  }>;
  /**
   * The zero-enabled-providers signal (§6.5): how many LOADED
   * provider-tier plugins are effectively `enabled` in the workspace.
   */
  readonly enabledProviderCount: (workspaceId: string) => Promise<number>;
  /**
   * Set/clear one workspace's state for one plugin (`"unset"` returns it
   * to the blank slate — the record is deleted). Refuses unloaded plugins
   * (`unloaded`) and core plugins (`core-locked`) — strict layering (§7).
   */
  readonly setState: (
    workspaceId: string,
    pluginId: string,
    state: SetWorkspaceStateRequest,
  ) => Promise<SetWorkspaceStateResult>;
}

/** Read every stored record for one workspace (the marker decodes to undefined). */
async function readWorkspaceRecords(
  storage: StorageNamespace,
  workspaceId: string,
): Promise<Map<string, StoredRecord>> {
  const records = new Map<string, StoredRecord>();
  for (const key of await storage.keys(`${workspaceId}/`)) {
    const raw = await storage.get(key);
    if (raw === null) continue;
    const decoded = decodeStateRecord(raw);
    if (decoded === undefined) continue; // the marker + unparsable values
    records.set(key.slice(workspaceId.length + 1), decoded);
  }
  return records;
}

/** Project records → the plain state map the enforcement reads want. */
function statesOf(records: ReadonlyMap<string, StoredRecord>): Map<string, WorkspacePluginState> {
  const states = new Map<string, WorkspacePluginState>();
  for (const [pluginId, record] of records) {
    states.set(pluginId, record.state);
  }
  return states;
}

export function createWorkspacePluginConfigService(
  deps: WorkspacePluginConfigDeps,
): WorkspacePluginConfigService {
  const { storage, logger } = deps;

  /**
   * Read-through materialization (§6.1): the FIRST read of a workspace's
   * plugin state snapshots the default workspace's current state
   * (Core → `enabled` always) and latches the workspace with a marker so
   * later reads (and later default-workspace changes) never rewrite it.
   * Fill-gaps-only: an existing per-workspace record is never overwritten.
   */
  async function ensureMaterialized(workspaceId: string): Promise<void> {
    const markerKey = materializedMarkerKey(workspaceId);
    if (await storage.has(markerKey)) return;
    const catalog = deps.getPlugins();
    const workspaceStates = statesOf(await readWorkspaceRecords(storage, workspaceId));
    const defaultStates =
      workspaceId === DEFAULT_WORKSPACE_ID
        ? new Map<string, WorkspacePluginState>()
        : statesOf(await readWorkspaceRecords(storage, DEFAULT_WORKSPACE_ID));
    const writes: readonly MaterializationWrite[] = planMaterialization(
      catalog,
      workspaceStates,
      defaultStates,
    );
    for (const w of writes) {
      const tier = catalog.find((p) => p.id === w.pluginId)?.tier ?? "standard";
      await storage.set(storageKey(workspaceId, w.pluginId), encodeStateRecord(w.state, tier));
    }
    await storage.set(markerKey, "1");
    logger.debug("workspace-plugin-config: materialized workspace", {
      workspaceId,
      written: writes.length,
    });
  }

  return {
    async stateOf(workspaceId, pluginId) {
      await ensureMaterialized(workspaceId);
      const raw = await storage.get(storageKey(workspaceId, pluginId));
      if (raw === null) return undefined;
      return decodeStateRecord(raw)?.state;
    },

    async effectiveStates(workspaceId) {
      await ensureMaterialized(workspaceId);
      return statesOf(await readWorkspaceRecords(storage, workspaceId));
    },

    async view(workspaceId) {
      await ensureMaterialized(workspaceId);
      const catalog = deps.getPlugins();
      const records = await readWorkspaceRecords(storage, workspaceId);

      // Rows for loaded plugins first (the materialized view), then rows
      // for any stored record whose plugin is NOT currently loaded
      // (unloaded → the modal greys it; the tier comes from the
      // tier-stamped record).
      const rows: WorkspacePluginRow[] = [];
      let enabledProviderCount = 0;
      for (const plugin of catalog) {
        const state = records.get(plugin.id)?.state;
        if (plugin.tier === "providers" && state === "enabled") enabledProviderCount += 1;
        rows.push({
          pluginId: plugin.id,
          tier: plugin.tier,
          state: state ?? "undefined",
          loaded: true,
          locked: plugin.tier === "core",
        });
      }
      for (const [pluginId, record] of records) {
        if (catalog.some((p) => p.id === pluginId)) continue;
        rows.push({
          pluginId,
          tier: record.tier ?? "standard",
          state: record.state,
          loaded: false,
          locked: record.tier === "core",
        });
      }
      return { plugins: rows, enabledProviderCount };
    },

    async enabledProviderCount(workspaceId) {
      await ensureMaterialized(workspaceId);
      const catalog = deps.getPlugins();
      const records = await readWorkspaceRecords(storage, workspaceId);
      let count = 0;
      for (const plugin of catalog) {
        if (plugin.tier !== "providers") continue;
        // isPluginUsable and state==="enabled" agree for the providers tier
        // (usable ⇔ enabled) — the named helper keeps the rule in one place.
        if (isPluginUsable(plugin.tier, records.get(plugin.id)?.state)) count += 1;
      }
      return count;
    },

    async setState(workspaceId, pluginId, state) {
      const validation = validateSetState(pluginId, deps.getPlugins());
      if (!validation.ok) {
        return { ok: false, reason: validation.reason };
      }
      const key = storageKey(workspaceId, pluginId);
      if (state === "unset") {
        await storage.delete(key);
        return { ok: true, state: undefined };
      }
      const tier = deps.getPlugins().find((p) => p.id === pluginId)?.tier ?? "standard";
      await storage.set(key, encodeStateRecord(state, tier));
      return { ok: true, state };
    },
  };
}
