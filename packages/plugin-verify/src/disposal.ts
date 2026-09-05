/**
 * The disposal-contract check — the test-host half of the verify-plugin
 * harness (plan 08 §8.3).
 *
 * Loads the plugin under test into a THROWAWAY kernel host (plan-01 engine),
 * then unloads and reloads it, asserting:
 *
 * 1. **Zero dangling registrations** — the plan-01 ledger's disposal contract
 *    (tools/providers/auth/services/filters/subscriptions/jobs). Anything the
 *    plugin's `deactivate()` left behind is force-cleaned by the host and
 *    reported in `UnloadResult.dangling`; the harness fails on ANY entry.
 * 2. **No leaked surfaces** — surface registrations are SERVICE-mediated
 *    (`surfaceRegistryHandle.register(...)`), so they are invisible to the
 *    ledger (plan 01 §1.4 note). The harness therefore ALSO asserts the
 *    plugin's surfaces are gone from the registry's catalog after unload.
 *    A plugin attributes its surfaces by `catalogEntry.pluginId === manifest.id`
 *    (the scaffold demonstrates the convention); `ownedSurfaceIds` lets a
 *    plugin under test declare additional surface ids to check.
 *
 * The environment (the OTHER extensions the plugin needs loaded — e.g. the
 * core `surface-registry`) is injected by the caller, keeping this module's
 * effect surface explicit. No mocking of Dispatch modules — a real bus, a
 * real host, real in-memory host deps.
 */

import {
  createBus,
  createHost,
  createLogger,
  type Extension,
  type HostAPI,
  type Logger,
  resolveActivationOrderSafe,
} from "@dispatch/kernel";
import { createSurfaceRegistryExtension, surfaceRegistryHandle } from "@dispatch/surface-registry";

/** The outcome of the disposal + surface-leak check. */
export interface DisposalCheckResult {
  readonly ok: boolean;
  /** SPECIFIC failure messages (which registration leaked, which surface stayed). */
  readonly errors: readonly string[];
}

export interface VerifyDisposalOpts {
  /**
   * Extensions the plugin needs loaded AROUND it (its `dependsOn` targets,
   * e.g. the core surface-registry). Loaded before the plugin in ONE host.
   * Defaults to just the surface-registry (the common environment).
   */
  readonly environment?: readonly Extension[];
  /**
   * Additional surface catalog ids the plugin is expected to deregister
   * (for plugins whose catalog entries don't stamp `pluginId`). The default
   * attribution is `catalogEntry.pluginId === manifest.id`.
   */
  readonly ownedSurfaceIds?: readonly string[];
}

/** A silent LogSink — the test host must not spew (failures come from the report). */
const silentSink = { emit: () => {} };

function makeLogger(): Logger {
  return createLogger({ extensionId: "plugin-verify" }, silentSink, {
    now: () => 0,
    newId: () => "verify",
  });
}

/** In-memory host deps — same shape the kernel's own tests use (no Dispatch mocks). */
export function makeHostDeps(logger: Logger) {
  const stores = new Map<string, Map<string, string>>();
  return {
    logger,
    config: { get: () => undefined, getAll: () => ({}) },
    storageFactory: (ns: string) => {
      let store = stores.get(ns);
      if (!store) {
        store = new Map();
        stores.set(ns, store);
      }
      const s = store;
      return {
        get: async (key: string) => s.get(key) ?? null,
        set: async (key: string, value: string) => {
          s.set(key, value);
        },
        delete: async (key: string) => {
          s.delete(key);
        },
        has: async (key: string) => s.has(key),
        keys: async () => [...s.keys()],
      };
    },
    secrets: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    },
    permissions: { check: async () => ({ allowed: true }) },
    scheduler: { register: () => {}, unregister: () => {} },
    bus: createBus(logger),
    events: { emit: () => {} },
    logSink: silentSink,
    logDeps: { now: () => 0, newId: () => "verify" },
  };
}

/**
 * Run the plugin under test through boot-activation → unload → load →
 * reload → unload in a fresh host, and report every violation with a
 * specific message. Never throws — a broken plugin is a REPORT, so the
 * caller (test or CLI) can fail loudly with the full problem list.
 *
 * Fault tolerance: `createHost` throws on an unresolvable DAG (an unmet
 * `dependsOn` or a cycle) instead of disabling-with-reason — that is boot
 * grammar, not harness grammar. The harness PRE-RESOLVES with the
 * non-throwing `resolveActivationOrderSafe` and converts every unmet dep /
 * cycle into a reported problem.
 */
export async function verifyDisposal(
  ext: Extension,
  opts: VerifyDisposalOpts = {},
): Promise<DisposalCheckResult> {
  const environment = opts.environment ?? [createSurfaceRegistryExtension()];
  const errors: string[] = [];

  // Pre-resolve the DAG NON-throwingly: unmet dependsOn targets (including
  // cycle members — all their deps are unresolved) become specific reported
  // problems instead of a createHost crash.
  const resolution = resolveActivationOrderSafe(
    [...environment, ext].map((e) => e.manifest),
    {},
  );
  for (const unmet of resolution.unmet) {
    if (unmet.missing.length > 0) {
      errors.push(
        `unmet dependencies: extension "${unmet.manifest.id}" depends on ${unmet.missing.map((d) => `"${d}"`).join(", ")}, which is not loaded — declare only plugins that will be in the load set (the harness environment or the bundled set)`,
      );
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const id = ext.manifest.id;
  const host = createHost([...environment, ext], makeHostDeps(makeLogger()));

  /** The surface ids STILL in the catalog that this plugin owns. */
  const leakedSurfaces = (): string[] => {
    try {
      const api: HostAPI = host.getHostAPI();
      const registry = api.tryGetService(surfaceRegistryHandle);
      const catalog = registry?.getCatalog() ?? [];
      if (opts.ownedSurfaceIds !== undefined) {
        const owned = new Set(opts.ownedSurfaceIds);
        return catalog.filter((e) => owned.has(e.id)).map((e) => e.id);
      }
      return catalog.filter((e) => e.pluginId === ext.manifest.id).map((e) => e.id);
    } catch {
      return [];
    }
  };

  await host.activate();

  // A plugin whose activation threw is swept and lands in getDisabled with
  // the reason — surface that verbatim instead of failing opaquely later.
  for (const d of host.getDisabled()) {
    if (d.manifest.id === id) {
      errors.push(`activation failed: ${d.reason}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // ── Round 1: activated at boot → unload ───────────────────────────────────
  const unload1 = await host.unloadExtension(id);
  if (!unload1.ok) {
    errors.push(`unload failed: ${unload1.reason}`);
    return { ok: false, errors };
  }
  for (const d of unload1.dangling ?? []) {
    errors.push(
      `dangling registration after deactivate(): ${d.kind} "${d.id}" — dispose it in deactivate() (every provideService / register / on / addFilter / onServiceAvailable / scheduler.register hands you a disposer)`,
    );
  }
  for (const sid of leakedSurfaces()) {
    errors.push(
      `leaked surface "${sid}" — still in the surface-registry catalog after deactivate(). Surface registrations are service-mediated and INVISIBLE to the disposal ledger; call the registry's unregister disposer in deactivate()`,
    );
  }

  // ── Round 2: fresh load → reload → unload (exercises the reload path) ────
  const load2 = await host.loadExtension(ext);
  if (!load2.ok) {
    errors.push(`re-load failed: ${load2.reason}`);
    return { ok: false, errors };
  }
  const reload = await host.reloadExtension(id, ext);
  if (!reload.ok) {
    errors.push(`reload failed: ${reload.reason}`);
    return { ok: false, errors };
  }
  const unload2 = await host.unloadExtension(id);
  if (!unload2.ok) {
    errors.push(`unload after reload failed: ${unload2.reason}`);
    return { ok: false, errors };
  }
  for (const d of unload2.dangling ?? []) {
    errors.push(
      `dangling registration after reload+deactivate(): ${d.kind} "${d.id}" — a reload re-runs activate(); every registration must be re-disposed each cycle`,
    );
  }
  for (const sid of leakedSurfaces()) {
    errors.push(`leaked surface "${sid}" still in the catalog after reload+deactivate()`);
  }

  return { ok: errors.length === 0, errors };
}
