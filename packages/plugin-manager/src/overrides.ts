/**
 * The plugin override-record contract — the CANONICAL home.
 *
 * The plugin-manager core extension OWNS the override store's writes (plan 05):
 * a record means "plugin X is disabled / was unloaded by the user", persisted
 * in the `plugin-overrides` KV namespace so a reboot honors the decision
 * (§6 — the DB records overrides, not full state; anything WITHOUT a record
 * loads at boot).
 *
 * Plan 04's boot reader (host-bin `plugin-reconcile.ts`) re-exports these
 * definitions from here so the reader and the writer cannot drift. This
 * module is pure: no I/O, no host import.
 */

/**
 * Storage namespace (the namespaced `StorageNamespace` KV) that holds the
 * override records. Key = extension id, value = JSON `PluginOverrideRecord`.
 */
export const PLUGIN_OVERRIDES_NAMESPACE = "plugin-overrides";

/**
 * Which writer path recorded the override. `"unloaded"` — a deliberate
 * user unload through the manager (the plugin stays unloaded across boots);
 * `"disabled"` — an explicit disable. Records written before this field
 * existed (plan 04 era) have no `kind` and read as `"disabled"`.
 */
export type PluginOverrideKind = "unloaded" | "disabled";

/**
 * A persisted user override. Anything WITHOUT a record here is loaded at
 * boot (§6 — overrides, not full state).
 */
export interface PluginOverrideRecord {
  readonly disabled: true;
  /** Which writer path recorded it (absent in plan-04-era records). */
  readonly kind?: PluginOverrideKind;
  /** Why it was disabled (shown in the manager UI). */
  readonly reason?: string;
  /** ISO timestamp of when the override was recorded. */
  readonly disabledAt?: string;
}

/** Serialize an override record for the KV store. */
export function encodeOverrideRecord(record: PluginOverrideRecord): string {
  return JSON.stringify(record);
}

/**
 * Parse a stored override record. Returns `undefined` for unparsable /
 * wrong-shaped values so callers can log-and-skip instead of crashing boot.
 */
export function decodeOverrideRecord(json: string): PluginOverrideRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  if ((parsed as { disabled?: unknown }).disabled !== true) return undefined;
  return parsed as PluginOverrideRecord;
}
