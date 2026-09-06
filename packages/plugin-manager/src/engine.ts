/**
 * The plugin lifecycle ENGINE — the consumer-defined contract the
 * plugin-manager defines for the host engine it drives (plan 01's
 * `loadExtension`/`unloadExtension`/`reloadExtension` + live
 * `getExtensions`/`getDisabled`) plus the plan-04 discovery machinery
 * (scan + reconcile) it needs at runtime.
 *
 * The handle is defined HERE (consumer side) and implemented by the
 * composition root (`host-bin/src/main.ts`), which owns the kernel `Host`
 * object and the plugins directory — mirroring how `transport-http`'s seam
 * defines `computerServiceHandle` for a producer that arrives later. The
 * composition root provides the implementation via the service registry
 * BEFORE `host.activate()`, so the manager's activate-time `getService` is
 * deterministic.
 *
 * Keeping the scan/reconcile access behind this handle (instead of importing
 * host-bin) is what keeps the dependency graph acyclic: host-bin →
 * plugin-manager (bundled set + engine impl), never the reverse.
 */

import type {
  DisabledExtension,
  Extension,
  LifecycleOperationOpts,
  LoadResult,
  Manifest,
  ReloadResult,
  ServiceHandle,
  UnloadResult,
} from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import type { PluginOverrideRecord } from "./overrides.js";

/**
 * Flat, kernel-typed view of one scanned plugin directory. The composition
 * root adapts plan-04's `ScanResult` to this — the manager never imports
 * host-bin. `kind` mirrors the scan statuses:
 * - `"loadable"` — valid manifest, apiVersion-compatible, entry resolved.
 * - `"invalid"` — manifest missing/unparsable/failed validation (`errors`).
 * - `"incompatible"` — valid manifest, apiVersion incompatible (`reason`).
 */
export interface ScannedPluginEntry {
  readonly dir: string;
  readonly kind: "loadable" | "invalid" | "incompatible";
  /** The validated manifest (`loadable` and `incompatible` only). */
  readonly manifest?: Manifest;
  /** Absolute code-entry path (`loadable` only). */
  readonly entryPath?: string;
  /** Validation errors (`invalid` only). */
  readonly errors?: readonly string[];
  /** Incompatibility reason (`incompatible` only). */
  readonly reason?: string;
}

/**
 * The RECONCILED scan buckets (plan-04 `reconcilePlugins`, `mode: "scan"`,
 * flattened) — what the manager merges with the live engine state to derive
 * the list view. The composition root runs the pure reconcile against the
 * override map the manager supplies (the manager owns the store).
 */
export interface ReconciledScanBuckets {
  /** Loadable, not loaded, no override — fresh discoveries (consent gate). */
  readonly unchecked: readonly {
    readonly dir: string;
    readonly manifest: Manifest;
  }[];
  /** Loadable and already live (bookkeeping — folded into the loaded rows). */
  readonly alreadyLoaded: readonly {
    readonly dir: string;
    readonly manifest: Manifest;
  }[];
  /** Present but disabled by an override record. */
  readonly disabledByOverride: readonly {
    readonly dir: string;
    readonly manifest: Manifest;
    readonly record: PluginOverrideRecord;
  }[];
  /** Present but refused (duplicate id / unmet deps). */
  readonly disabledWithReason: readonly {
    readonly dir: string;
    readonly manifest: Manifest;
    readonly reason: string;
  }[];
  /** Override records whose plugin dir is GONE — greyed-out "missing" rows. */
  readonly missing: readonly {
    readonly id: string;
    readonly record: PluginOverrideRecord;
  }[];
}

/** One scan-and-reconcile pass over the plugins root. */
export interface PluginScanResult {
  readonly scanned: readonly ScannedPluginEntry[];
  readonly buckets: ReconciledScanBuckets;
}

/**
 * The engine surface the manager drives. Everything is the kernel host's
 * plan-01 lifecycle machinery or the plan-04 discovery machinery, injected —
 * the manager holds no references to the kernel `Host` object itself.
 */
export interface PluginEngine {
  readonly getExtensions: () => readonly Manifest[];
  readonly getDisabled: () => readonly DisabledExtension[];
  readonly loadExtension: (ext: Extension) => Promise<LoadResult>;
  readonly unloadExtension: (id: string, opts?: LifecycleOperationOpts) => Promise<UnloadResult>;
  readonly reloadExtension: (
    id: string,
    ext: Extension,
    opts?: LifecycleOperationOpts,
  ) => Promise<ReloadResult>;
  /**
   * Scan the plugins root and reconcile it against the given override map
   * (the manager passes its own store contents) in `mode: "scan"` — new
   * discoveries come back UNCHECKED (consent gate, §5), never auto-loaded.
   */
  readonly scanPluginsDir: (
    overrides: ReadonlyMap<string, PluginOverrideRecord>,
  ) => Promise<PluginScanResult>;
  /**
   * Cache-busted import of a plugin entry file (plan-04 `loadPlugin`).
   * `undefined` when the entry is broken — the engine logs + skips, never
   * throws for a bad plugin.
   */
  readonly importPluginEntry: (entryPath: string) => Promise<Extension | undefined>;
  /** The resolved plugins root (boot-resolved by the composition root). */
  readonly pluginsDir: string;
}

/** Typed service handle the composition root provides and the manager consumes. */
export const pluginEngineHandle: ServiceHandle<PluginEngine> = defineService<PluginEngine>(
  "plugin-manager/host-engine",
);
