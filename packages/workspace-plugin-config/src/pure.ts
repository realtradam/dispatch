/**
 * Pure decision core for per-workspace plugin enablement (plan 06).
 *
 * No I/O, no clocks, no host import — every function here is `input →
 * output` so the enforcement plane (tool gate, model gate, surface filter)
 * and the store service share ONE rule set that is unit-test dense.
 *
 * ## The state model
 *
 * Per (workspaceId, pluginId) the store holds one of:
 * - `"enabled"` — usable in this workspace (subject to being loaded).
 * - `"disabled"` — not usable in this workspace ("not use", §7 — the
 *   plugin stays loaded globally; nothing is removed).
 * - `undefined` — NO record (the blank slate, §7). For Providers +
 *   Standard tiers `undefined` behaves as disabled; for Core it behaves
 *   as enabled (Core is enabled-by-default — plan 00 Q-A).
 *
 * ## Blank slate + inheritance
 *
 * The default workspace (`"default"`) is the template. A workspace has no
 * record of a plugin until it is materialized: the FIRST read of a
 * workspace's plugin state snapshots the default workspace's CURRENT state
 * (Core is the exception — it always materializes to `enabled`). Later
 * changes to the default workspace never retroactively change an
 * already-materialized workspace.
 */

import type { PluginTier } from "@dispatch/kernel";

/**
 * The well-known workspace id the conversation store synthesizes when a
 * conversation has no persisted workspace. It is the inheritance template:
 * a workspace materializes its per-plugin states from the default
 * workspace's state at first read.
 */
export const DEFAULT_WORKSPACE_ID = "default";

/**
 * A per-workspace plugin state as stored/read. `undefined` means "no
 * record" — the blank slate (§7), NEVER written by materialization.
 */
export type WorkspacePluginState = "enabled" | "disabled" | undefined;

/** A materializable plugin: the loaded-manifest view the service reads. */
export interface CatalogPlugin {
  readonly id: string;
  readonly tier: PluginTier;
}

/**
 * The inheritance rule (§6.1, pure). What state a workspace materializes
 * for a plugin given the plugin's tier and the default workspace's CURRENT
 * state:
 * - Core tier → ALWAYS `"enabled"` (Q-A: Core is enabled-by-default in
 *   every workspace; it does not inherit the default workspace's blank
 *   slate).
 * - Providers/Standard → inherit verbatim: default `enabled` → `enabled`;
 *   default `disabled` → `disabled`; default `undefined` → `undefined`
 *   ( NOTHING is written — the workspace stays blank for that plugin
 *   until the user explicitly enables it there).
 */
export function inheritState(
  tier: PluginTier,
  defaultState: WorkspacePluginState,
): WorkspacePluginState {
  if (tier === "core") return "enabled";
  return defaultState;
}

/**
 * The single effective-enablement rule (§6.2) every enforcement point
 * applies — a plugin is USABLE in a workspace iff it is loaded globally
 * (checked by the caller) AND:
 * - tier `"core"` → usable unless the workspace explicitly set it
 *   `disabled` (`enabled`/`undefined` → usable; Q-A: enabled-by-default,
 *   not hard-locked — an explicit disable is honored wherever one exists).
 * - tier `"providers" | "standard"` → usable only when `enabled`;
 *   `undefined` (blank slate) behaves as disabled.
 */
export function isPluginUsable(tier: PluginTier, state: WorkspacePluginState): boolean {
  if (tier === "core") return state !== "disabled";
  return state === "enabled";
}

/** One materialization write the service applies to the store. */
export interface MaterializationWrite {
  readonly pluginId: string;
  readonly state: "enabled" | "disabled";
}

/**
 * Compute the materialization writes for a workspace's first read
 * (§6.1 read-through materialization, pure). Fill-gaps-only: a plugin that
 * already has a record in the workspace is NEVER overwritten (the user's
 * explicit per-workspace state wins). Core materializes to `enabled`;
 * Providers/Standard inherit the default workspace's current state, and an
 * inherited `undefined` produces NO write (blank slate).
 *
 * @param catalog  The currently-LOADED plugins (id + tier).
 * @param workspaceStates  The workspace's existing records (pluginId → state).
 * @param defaultStates  The default workspace's current records. Pass an
 *   empty map when materializing the default workspace itself (it
 *   inherits from nothing; fill-gaps + the Core rule still apply).
 */
export function planMaterialization(
  catalog: readonly CatalogPlugin[],
  workspaceStates: ReadonlyMap<string, WorkspacePluginState>,
  defaultStates: ReadonlyMap<string, WorkspacePluginState>,
): readonly MaterializationWrite[] {
  const writes: MaterializationWrite[] = [];
  for (const plugin of catalog) {
    if (workspaceStates.get(plugin.id) !== undefined) continue; // fill-gaps-only
    const inherited = inheritState(plugin.tier, defaultStates.get(plugin.id));
    if (inherited === undefined) continue; // blank slate — no write
    writes.push({ pluginId: plugin.id, state: inherited });
  }
  return writes;
}

/**
 * Validate a `PUT /workspaces/:id/plugins/:pluginId` state change (§6.6,
 * pure). Strict layering (§7): only the global plugin-manager loads code,
 * so the per-workspace surface refuses to change the state of a plugin
 * that is NOT currently loaded (`unloaded`) and refuses CORE plugins
 * (`core-locked` — the workspace modal renders core rows as locked; see
 * the report note on §6.1 vs §6.6 for the pure `isPluginUsable` rule,
 * which still honors an explicit core `disabled` wherever one exists).
 */
export type SetStateValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unloaded" | "core-locked" };

export function validateSetState(
  pluginId: string,
  catalog: readonly CatalogPlugin[],
): SetStateValidation {
  const plugin = catalog.find((p) => p.id === pluginId);
  if (plugin === undefined) return { ok: false, reason: "unloaded" };
  if (plugin.tier === "core") return { ok: false, reason: "core-locked" };
  return { ok: true };
}

// ── Storage codec ───────────────────────────────────────────────────────────

/**
 * The KV namespace (a kernel `StorageNamespace`) that holds the
 * per-workspace plugin states. Owned exclusively by the
 * workspace-plugin-config extension (§12 — one owner per unit).
 */
export const WORKSPACE_PLUGIN_CONFIG_NAMESPACE = "workspace-plugin-config";

/** Store key for a (workspace, plugin) pair: `<workspaceId>/<pluginId>`. */
export function storageKey(workspaceId: string, pluginId: string): string {
  return `${workspaceId}/${pluginId}`;
}

/**
 * Reserved key suffix marking "this workspace has been materialized" (the
 * snapshot-at-first-read latch). Not a plugin id — manifest ids are
 * kebab-case and never collide with it.
 */
export const MATERIALIZED_MARKER_PLUGIN_ID = "__materialized__";

export function materializedMarkerKey(workspaceId: string): string {
  return storageKey(workspaceId, MATERIALIZED_MARKER_PLUGIN_ID);
}

/**
 * Serialize a stored state record (`{ state, tier }` — the tier is stamped
 * at write time so rows for NOT-currently-loaded plugins can still report
 * their tier; plan-04 record style).
 */
export function encodeStateRecord(state: "enabled" | "disabled", tier: PluginTier): string {
  return JSON.stringify({ state, tier });
}

/**
 * Parse a stored state record. Returns `undefined` for unparsable /
 * wrong-shaped values (and for the materialization marker's `"1"`) so
 * callers log-and-skip instead of crashing a read.
 */
export function decodeStateRecord(
  json: string,
): { state: "enabled" | "disabled"; tier?: PluginTier } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const state = (parsed as { state?: unknown }).state;
  if (state !== "enabled" && state !== "disabled") return undefined;
  const tier = (parsed as { tier?: unknown }).tier;
  return {
    state,
    ...(tier === "core" || tier === "providers" || tier === "standard" ? { tier } : {}),
  };
}
