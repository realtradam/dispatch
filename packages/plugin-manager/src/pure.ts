/**
 * Pure decision logic of the plugin-manager — every §8 policy rule as an
 * input→output function (AGENTS.md: effects live at the edges, injected).
 * No I/O, no host import: the service shell (service.ts) feeds these
 * functions engine snapshots + store contents and applies their verdicts.
 *
 * Policies implemented here (big_plan §8, enforced server-side):
 * - core is locked (never unloadable — the manager itself included);
 * - unloading the LAST loaded provider-tier plugin is refused (the one hard
 *   lock — never force-able);
 * - unloading/reloading a plugin with loaded dependents requires `force`
 *   and reports the cascade (dependents unload reverse-topologically first);
 * - force stops ALL agents globally (the service shell calls the injected
 *   `stopAllAgents` before the engine calls — §8).
 */

import * as path from "node:path";

import type { Manifest } from "@dispatch/kernel";
import type {
  DisabledWithReasonRow,
  DiscoveredPluginRow,
  LoadedPluginRow,
  MissingPluginRow,
  PluginBlockReason,
  PluginListResponse,
  PluginOverrideInfo,
  PluginScanResponse,
} from "@dispatch/transport-contract";
import type { PluginScanResult, ReconciledScanBuckets, ScannedPluginEntry } from "./engine.js";
import type { PluginOverrideRecord } from "./overrides.js";

// ── Manifest → wire-row mapping ─────────────────────────────────────────────

/** Map a live manifest to its `loaded` table row (`locked` = core tier). */
export function toLoadedRow(
  manifest: Manifest,
  frontendBusts?: ReadonlyMap<string, string>,
): LoadedPluginRow {
  const bust = frontendBusts?.get(manifest.id);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    tier: manifest.tier,
    trust: manifest.trust,
    locked: manifest.tier === "core",
    dependsOn: [...(manifest.dependsOn ?? [])],
    // Additive (plan 03): present only when the plugin declares a frontend
    // section AND its entry file was stat-able at list time (an unservable
    // entry is omitted — the route would 404 it anyway).
    ...(manifest.frontend !== undefined && bust !== undefined
      ? {
          frontend: {
            apiVersion: manifest.frontend.apiVersion,
            entry: manifest.frontend.entry,
            bust,
          },
        }
      : {}),
  };
}

/** Map a manifest + reason to a `disabled-with-reason` row. */
export function toDisabledWithReasonRow(manifest: Manifest, reason: string): DisabledWithReasonRow {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    tier: manifest.tier,
    trust: manifest.trust,
    reason,
  };
}

/** Map a manifest + dir (+ optional persisted override) to a `discovered` row. */
export function toDiscoveredRow(
  manifest: Manifest,
  dir: string,
  override?: PluginOverrideInfo,
): DiscoveredPluginRow {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    tier: manifest.tier,
    trust: manifest.trust,
    dir,
    ...(override !== undefined ? { override } : {}),
  };
}

/** Map an override record to its wire shape (storage shape → UI shape). */
export function toOverrideInfo(record: PluginOverrideRecord): PluginOverrideInfo {
  return {
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.disabledAt !== undefined ? { disabledAt: record.disabledAt } : {}),
  };
}

/** Map a missing row (record without a directory) to its wire shape. */
export function toMissingRow(id: string, record: PluginOverrideRecord): MissingPluginRow {
  return {
    id,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.disabledAt !== undefined ? { disabledAt: record.disabledAt } : {}),
  };
}

/**
 * The override record a user-initiated unload persists: the plugin stays
 * unloaded across boots (§6 — without a record, boot default-on would
 * reload it) and `list()` can tell it apart from an explicit disable
 * (plan-01 §1.6: a user unload is its own bucket, rendered differently).
 */
export function overrideForUnload(disabledAt: string): PluginOverrideRecord {
  return { disabled: true, kind: "unloaded", reason: "unloaded by user", disabledAt };
}

// ── Cascade computation (§8 dependent semantics) ────────────────────────────

/**
 * The set of LOADED extensions that (transitively) depend on `targetId`,
 * ordered reverse-topologically — leaf dependents first, so unloading in
 * list order never strands a dependent behind an already-removed edge.
 * The target itself is NOT in the result.
 *
 * Derived from the live loaded manifests: a plugin is a dependent iff its
 * `dependsOn` chain reaches `targetId`.
 */
export function computeUnloadCascade(
  loaded: readonly Manifest[],
  targetId: string,
): readonly string[] {
  const byId = new Map<string, Manifest>();
  for (const m of loaded) byId.set(m.id, m);

  // Transitive dependents (BFS over reverse edges).
  const dependents = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of loaded) {
      if (dependents.has(m.id) || m.id === targetId) continue;
      const deps = m.dependsOn ?? [];
      if (deps.includes(targetId) || deps.some((d) => dependents.has(d))) {
        dependents.add(m.id);
        changed = true;
      }
    }
  }

  // Order: reverse activation (topological) position — dependents of
  // dependents unload first. Loaded sets are consistent DAGs, so every
  // dependent has a topological position.
  const topoOrder = topologicalOrder(loaded);
  return [...dependents]
    .map((id) => topoOrder.indexOf(id))
    .filter((idx) => idx >= 0)
    .sort((a, b) => b - a)
    .map((idx) => topoOrder[idx] as string);
}

/**
 * Topological order of the loaded manifests (dependencies first), stable
 * for already-consistent input. Cycles cannot occur among LOADED extensions
 * (the engine only activates dependency-safe sets); a malformed input set
 * degrades to append order for the unresolvable remainder.
 */
function topologicalOrder(loaded: readonly Manifest[]): string[] {
  const byId = new Map<string, Manifest>();
  for (const m of loaded) byId.set(m.id, m);
  const result: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (id: string): void => {
    if (done.has(id) || visiting.has(id)) return;
    const m = byId.get(id);
    if (m === undefined) return;
    visiting.add(id);
    for (const dep of m.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    done.add(id);
    result.push(id);
  };
  for (const m of loaded) visit(m.id);

  // Anything not reached (cycle member — impossible for loaded sets) appends
  // in input order so the function is total.
  for (const m of loaded) {
    if (!done.has(m.id)) result.push(m.id);
  }
  return result;
}

// ── Unload policy (§8) ──────────────────────────────────────────────────────

export interface UnloadDecisionInput {
  /** Live loaded manifests (the engine's `getExtensions()` snapshot). */
  readonly loaded: readonly Manifest[];
  readonly targetId: string;
  readonly force: boolean;
}

export type LifecycleDecision =
  | {
      readonly kind: "allowed";
      /** Loaded dependents to unload before the target (reverse-topological). */
      readonly cascade: readonly string[];
      /** Force swaps land immediately — all agents stop first (§8). */
      readonly stopAgents: boolean;
    }
  | {
      readonly kind: "blocked";
      readonly reason: PluginBlockReason;
      readonly message: string;
      readonly dependents?: readonly string[];
    };

/**
 * The unload policy verdict for one target. Rules, in precedence order:
 * 1. not loaded → `not-loaded`;
 * 2. tier "core" → `core-locked` (never force-able);
 * 3. the last loaded provider → `last-provider` (never force-able — the §8
 *    hard lock; a session without providers cannot pick models);
 * 4. loaded dependents without `force` → `cascade-needs-force` with the
 *    dependent list (the client warns "unloading X also unchecks Y, Z");
 * 5. otherwise allowed — with `force` the agents stop first (global stop,
 *    plan-00 question 2) and the cascade unloads reverse-topologically.
 */
export function classifyUnload(input: UnloadDecisionInput): LifecycleDecision {
  const target = input.loaded.find((m) => m.id === input.targetId);
  if (target === undefined) {
    return {
      kind: "blocked",
      reason: "not-loaded",
      message: `Plugin "${input.targetId}" is not loaded`,
    };
  }
  if (target.tier === "core") {
    return {
      kind: "blocked",
      reason: "core-locked",
      message: `Plugin "${input.targetId}" is a core plugin — core plugins cannot be unloaded`,
    };
  }
  if (target.tier === "providers") {
    const loadedProviders = input.loaded.filter((m) => m.tier === "providers");
    if (loadedProviders.length <= 1) {
      return {
        kind: "blocked",
        reason: "last-provider",
        message: `Plugin "${input.targetId}" is the last loaded provider — unloading it would leave no providers`,
      };
    }
  }
  const cascade = computeUnloadCascade(input.loaded, input.targetId);
  if (cascade.length > 0 && !input.force) {
    const list = cascade.map((d) => `"${d}"`).join(", ");
    return {
      kind: "blocked",
      reason: "cascade-needs-force",
      message: `Cannot unload "${input.targetId}": ${cascade.length} loaded plugin(s) depend on it (${list}) — retry with force`,
      dependents: cascade,
    };
  }
  return { kind: "allowed", cascade, stopAgents: input.force };
}

/**
 * The reload policy verdict. Reload swaps the code of a loaded plugin; the
 * §8 locks that forbid UNLOAD do not apply (the plugin stays loaded — a
 * failed reload lands in disabled-with-reason, and the user re-loads), but
 * the dependent rule does: the engine (plan-01 §1.4) refuses a reload with
 * loaded dependents unless `force`, cascading them around the swap. A
 * not-loaded target degenerates to a plain load (the engine's semantics).
 */
export function classifyReload(input: UnloadDecisionInput): LifecycleDecision {
  const target = input.loaded.find((m) => m.id === input.targetId);
  if (target === undefined) {
    // Reload of an unloaded plugin is a load — allowed, no cascade.
    return { kind: "allowed", cascade: [], stopAgents: input.force };
  }
  const cascade = computeUnloadCascade(input.loaded, input.targetId);
  if (cascade.length > 0 && !input.force) {
    const list = cascade.map((d) => `"${d}"`).join(", ");
    return {
      kind: "blocked",
      reason: "cascade-needs-force",
      message: `Cannot reload "${input.targetId}": ${cascade.length} loaded plugin(s) depend on it (${list}) — retry with force`,
      dependents: cascade,
    };
  }
  return { kind: "allowed", cascade, stopAgents: input.force };
}

// ── Frontend entry access (plan 03) ─────────────────────────────────────────

/** Why `GET /plugins/:id/frontend` refuses to serve (all map to 404 — a
 * disabled plugin's code must not be fetchable, and the refusal reason must
 * not leak which case hit). */
export type FrontendEntryBlockReason =
  | "not-found"
  | "not-loaded"
  | "no-frontend"
  | "workspace-disabled"
  | "entry-escapes";

/** The verdict for one frontend-entry request (pure — the service adds I/O). */
export type FrontendEntryVerdict =
  | {
      readonly kind: "allowed";
      /** Absolute plugin directory (from the scan). */
      readonly dir: string;
      /** Absolute entry-file path (resolved + prefix-checked). */
      readonly entryPath: string;
    }
  | { readonly kind: "blocked"; readonly reason: FrontendEntryBlockReason };

export interface FrontendAccessInput {
  /** Live loaded manifests (engine `getExtensions()` snapshot). */
  readonly loaded: readonly Manifest[];
  /** The current scan (provides plugin DIRECTORIES — loaded manifests don't carry them). */
  readonly scanned: readonly ScannedPluginEntry[];
  readonly targetId: string;
  /** Whether the plugin is enabled in the requesting client's active workspace. */
  readonly workspaceEnabled: boolean;
}

/**
 * The `GET /plugins/:id/frontend` access verdict (plan 03 §3.1):
 * 1. unknown id (never scanned) → `not-found`;
 * 2. scanned but not loaded → `not-loaded`;
 * 3. no `frontend` manifest section → `no-frontend`;
 * 4. disabled in the caller's active workspace → `workspace-disabled`
 *    (a disabled plugin's code must not be fetchable);
 * 5. `frontend.entry` resolved OUTSIDE the plugin directory →
 *    `entry-escapes` (traversal-safe: resolve + prefix check, the same rule
 *    as the code-entry resolver in plan-04 discovery).
 * The target id itself is NEVER used as a path — the directory comes from
 * the scan, keyed by manifest id.
 */
export function classifyFrontendAccess(input: FrontendAccessInput): FrontendEntryVerdict {
  const scannedEntry = input.scanned.find(
    (e) => e.kind === "loadable" && e.manifest?.id === input.targetId,
  );
  if (scannedEntry === undefined) {
    // Never seen on disk at all, or a broken dir — indistinguishable from
    // "no such plugin" for a client.
    return { kind: "blocked", reason: "not-found" };
  }
  if (!input.loaded.some((m) => m.id === input.targetId)) {
    return { kind: "blocked", reason: "not-loaded" };
  }
  const manifest = scannedEntry.manifest;
  const frontend = manifest?.frontend;
  if (manifest === undefined || frontend === undefined) {
    return { kind: "blocked", reason: "no-frontend" };
  }
  if (!input.workspaceEnabled) {
    return { kind: "blocked", reason: "workspace-disabled" };
  }
  // Traversal-safe entry resolution: the entry must stay INSIDE the plugin
  // directory (the same rule the plan-04 entry resolver enforces).
  const dir = scannedEntry.dir;
  const entryPath = path.resolve(dir, frontend.entry);
  const rel = path.relative(dir, entryPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { kind: "blocked", reason: "entry-escapes" };
  }
  return { kind: "allowed", dir, entryPath };
}

// ── Scan views ──────────────────────────────────────────────────────────────

/** The loadable entry for a plugin id, from a scan's flat entries. */
export function findLoadableEntry(
  scanned: readonly ScannedPluginEntry[],
  id: string,
): ScannedPluginEntry | undefined {
  return scanned.find((e) => e.kind === "loadable" && e.manifest?.id === id);
}

/** Derive the `POST /plugins/scan` response from one scan-and-reconcile pass. */
export function deriveScanResponse(scan: PluginScanResult, pluginsDir: string): PluginScanResponse {
  const newPlugins = scan.buckets.unchecked.map((u) => toDiscoveredRow(u.manifest, u.dir));
  const invalid = scan.scanned
    .filter((e): e is ScannedPluginEntry & { readonly kind: "invalid" } => e.kind === "invalid")
    .map((e) => ({ dir: e.dir, errors: [...(e.errors ?? [])] }));
  const incompatible = scan.scanned
    .filter((e) => e.kind === "incompatible" && e.manifest !== undefined)
    .map((e) => ({
      dir: e.dir,
      id: (e.manifest as Manifest).id,
      reason: e.reason ?? "incompatible with the running kernel",
    }));
  return { root: pluginsDir, newPlugins, invalid, incompatible };
}

// ── List derivation (the two manager tables + the missing strip) ────────────

export interface DeriveListInput {
  /** Live loaded manifests (engine `getExtensions()`). */
  readonly loaded: readonly Manifest[];
  /** Disabled-with-reason entries recorded by the ENGINE (boot + runtime attempts). */
  readonly engineDisabled: readonly { readonly manifest: Manifest; readonly reason: string }[];
  /** The current scan-and-reconcile pass (the manager just ran it). */
  readonly scan: PluginScanResult;
  /**
   * Frontend-entry cache-bust values (entry mtimeMs) per loaded plugin id
   * (plan 03) — collected by the service shell (I/O); rows for plugins
   * absent from the map (no frontend section, or an unservable entry) omit
   * the additive `frontend` field.
   */
  readonly frontendBusts?: ReadonlyMap<string, string>;
}

/**
 * Derive the `GET /plugins` view — the buckets the frontend's two tables
 * render, kept DISTINCT per plan-01 §1.6:
 * - `loaded` — live extensions (with the core `locked` flag);
 * - `disabledWithReason` — system-disabled (engine-recorded attempts, scan
 *   refusals, apiVersion-incompatible);
 * - `discovered` — present on disk, not loaded (fresh consent-gate rows
 *   without an override; user-disabled / user-unloaded rows carry the
 *   persisted override's `kind`);
 * - `missing` — override records whose plugin directory is gone.
 *
 * Deliberately NOT here: directories with broken manifests (no id to key a
 * row on) — the scan response is their diagnostic surface.
 */
export function deriveListView(input: DeriveListInput): PluginListResponse {
  const loaded = input.loaded.map((m) => toLoadedRow(m, input.frontendBusts));
  const loadedIds = new Set(input.loaded.map((m) => m.id));

  // Disabled-with-reason: engine-recorded attempts first (they carry
  // activation-failure reasons), then the scan's refusals + apiVersion
  // refusals, deduped by id (the engine entry wins — it is authoritative
  // for "we tried and it failed").
  const disabledWithReason: DisabledWithReasonRow[] = [];
  const disabledSeen = new Set<string>();
  for (const d of input.engineDisabled) {
    if (disabledSeen.has(d.manifest.id)) continue;
    disabledSeen.add(d.manifest.id);
    disabledWithReason.push(toDisabledWithReasonRow(d.manifest, d.reason));
  }
  const buckets: ReconciledScanBuckets = input.scan.buckets;
  for (const d of buckets.disabledWithReason) {
    if (disabledSeen.has(d.manifest.id)) continue;
    disabledSeen.add(d.manifest.id);
    disabledWithReason.push(toDisabledWithReasonRow(d.manifest, d.reason));
  }
  for (const entry of input.scan.scanned) {
    if (entry.kind !== "incompatible" || entry.manifest === undefined) continue;
    if (disabledSeen.has(entry.manifest.id) || loadedIds.has(entry.manifest.id)) continue;
    disabledSeen.add(entry.manifest.id);
    disabledWithReason.push(
      toDisabledWithReasonRow(
        entry.manifest,
        entry.reason ?? "incompatible with the running kernel",
      ),
    );
  }

  // Discovered: fresh consent-gate rows (no override — the checkbox is
  // unchecked) + override-recorded rows (user-disabled / user-unloaded —
  // the override's `kind` tells the UI which). Loaded ids are excluded
  // defensively: a correctly-reconciled scan never puts a live plugin in
  // these buckets, and the manager keeps that invariant local.
  const discovered: DiscoveredPluginRow[] = [];
  const discoveredSeen = new Set<string>(loadedIds);
  for (const u of buckets.unchecked) {
    if (discoveredSeen.has(u.manifest.id)) continue;
    discoveredSeen.add(u.manifest.id);
    discovered.push(toDiscoveredRow(u.manifest, u.dir));
  }
  for (const d of buckets.disabledByOverride) {
    if (discoveredSeen.has(d.manifest.id)) continue;
    discoveredSeen.add(d.manifest.id);
    discovered.push(toDiscoveredRow(d.manifest, d.dir, toOverrideInfo(d.record)));
  }

  const missing = buckets.missing.map((m) => toMissingRow(m.id, m.record));

  return { loaded, disabledWithReason, discovered, missing };
}
