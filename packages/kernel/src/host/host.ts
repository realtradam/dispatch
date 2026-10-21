import type { Bus } from "../bus/bus.js";
import type { AuthContract } from "../contracts/auth.js";
import type {
  ConfigAccess,
  EventsEmitter,
  Extension,
  HostAPI,
  Manifest,
  PermissionGate,
  ScheduledJob,
  SecretsAccess,
  StorageNamespace,
} from "../contracts/extension.js";
import type {
  EventHandler,
  EventHookDescriptor,
  FilterDescriptor,
  FilterHandler,
  ServiceHandle,
} from "../contracts/hooks.js";
import type { LogDeps, Logger, LogSink } from "../contracts/logging.js";
import type { ProviderContract } from "../contracts/provider.js";
import type { ToolContract } from "../contracts/tool.js";
import { createLogger } from "../logging/logger.js";
import { resolveActivationOrder, resolveActivationOrderSafe } from "./dag.js";
import { type DanglingRegistration, ExtensionLedger } from "./ledger.js";
import { isApiVersionCompatible } from "./version.js";

export const KERNEL_API_VERSION = "0.1.0";

export interface DisabledExtension {
  readonly manifest: Manifest;
  readonly reason: string;
}

/** Options for the runtime unload / reload operations. */
export interface LifecycleOperationOpts {
  /**
   * Proceed even when other loaded extensions depend on the target. For
   * unload this unloads the target only — cascade policy (which dependents
   * to unload with it) belongs to the manager layer. For reload, force also
   * cascades: dependents are unloaded and reloaded around the target.
   */
  readonly force?: boolean;
}

/** Result of a runtime load (or reload) attempt. */
export interface LoadResult {
  /** Whether the extension is now activated and live. */
  readonly ok: boolean;
  /** The loaded extension's manifest (when `ok`). */
  readonly manifest?: Manifest;
  /** Why the load was refused or failed (when not `ok`). */
  readonly reason?: string;
  /**
   * The disabled-with-reason entry recorded for this attempt (when not
   * `ok`). Refusals and failures land in `getDisabled()` — uniform grammar
   * with the boot path.
   */
  readonly disabled?: DisabledExtension;
}

/** Result of a runtime unload attempt. */
export interface UnloadResult {
  readonly ok: boolean;
  readonly id: string;
  /** The unloaded extension's manifest (when `ok`). */
  readonly manifest?: Manifest;
  /** Why the unload was refused (when not `ok`). */
  readonly reason?: string;
  /** Ids of loaded extensions that depend on the target (when refused). */
  readonly blockedBy?: readonly string[];
  /**
   * Registrations that survived `deactivate()` and were force-cleaned by the
   * host (disposal contract, §9). Empty/absent when the extension disposed
   * everything it owns.
   */
  readonly dangling?: readonly DanglingRegistration[];
  /** Error message when `deactivate()` itself threw (unload still completes). */
  readonly deactivateError?: string;
}

/** Result of a runtime reload attempt. */
export interface ReloadResult extends LoadResult {
  /** Ids of loaded extensions that depend on the target (when refused). */
  readonly blockedBy?: readonly string[];
  /**
   * Force path only: dependents that were unloaded (reverse-topological)
   * before the target was replaced.
   */
  readonly unloadedDependents?: readonly string[];
  /**
   * Force path only: dependents that were reloaded after the target
   * (topological, original activation order). Dependents whose reload failed
   * land in `getDisabled()` (uniform grammar) and are absent here.
   */
  readonly reloadedDependents?: readonly string[];
}

export interface HostDeps {
  readonly logger: Logger;
  readonly config: ConfigAccess;
  readonly storageFactory: (namespace: string) => StorageNamespace;
  readonly secrets: SecretsAccess;
  readonly permissions: PermissionGate;
  readonly scheduler: {
    readonly register: (job: ScheduledJob) => void;
    readonly unregister: (jobId: string) => void;
  };
  readonly bus: Bus;
  readonly events: EventsEmitter;
  readonly logSink: LogSink;
  readonly logDeps: LogDeps;
}

export interface Host {
  readonly activate: () => Promise<void>;
  readonly deactivate: () => Promise<void>;
  readonly getTools: () => ReadonlyMap<string, ToolContract>;
  readonly getTool: (name: string) => ToolContract | undefined;
  readonly getProviders: () => ReadonlyMap<string, ProviderContract>;
  readonly getProvider: (id: string) => ProviderContract | undefined;
  readonly getAuthProviders: () => ReadonlyMap<string, AuthContract>;
  readonly getAuthProvider: (id: string) => AuthContract | undefined;
  readonly getScheduledJobs: () => readonly ScheduledJob[];
  readonly getMigrations: () => readonly string[];
  readonly getDisabled: () => readonly DisabledExtension[];
  readonly getExtensions: () => readonly Manifest[];
  readonly getHostAPI: () => HostAPI;
  /**
   * Tool name → registering extension id, derived from the plan-01
   * registration ledger (every `defineTool` is tracked under the caller's
   * extension id — including filter-injected tools with runtime names no
   * manifest can enumerate, e.g. MCP's `<serverId>__<toolName>`). The
   * authoritative tool→plugin attribution for per-workspace enforcement
   * (plan 06 §6.3). Live view: reflects loads/unloads.
   */
  readonly getToolOwners: () => ReadonlyMap<string, string>;
  /**
   * Provider id → registering extension id, derived from the plan-01
   * registration ledger (every `defineProvider` is tracked under the
   * caller's extension id). The authoritative provider→plugin attribution
   * for per-workspace provider gating (plan 06 §6.5). Live view.
   */
  readonly getProviderOwners: () => ReadonlyMap<string, string>;
  /**
   * Activate a new extension into the running host. Refuses an id that is
   * already loaded (use `reloadExtension`), an apiVersion-incompatible
   * manifest, and unmet dependencies — each lands in `getDisabled()`
   * (disabled-with-reason, uniform grammar with the boot path).
   */
  readonly loadExtension: (ext: Extension) => Promise<LoadResult>;
  /**
   * Deactivate a loaded extension and remove every registration it made
   * (per-extension ledger), force-cleaning and logging anything its
   * `deactivate()` left behind. Refused while other loaded extensions
   * depend on it, unless `force` (cascade policy lives in the manager
   * layer). Note: a user-initiated unload is NOT a disabled-with-reason
   * entry — it simply disappears from `getExtensions()`.
   */
  readonly unloadExtension: (id: string, opts?: LifecycleOperationOpts) => Promise<UnloadResult>;
  /**
   * Replace a loaded extension with a fresh instance of the same id (from a
   * cache-busted import — supplied by the caller; the host never imports).
   * Reload = fresh load after removing the old instance. Refused while
   * loaded dependents exist unless `force`, in which case dependents are
   * unloaded (reverse-topological), the target reloaded, then the
   * dependents reloaded (topological). Accepted reality (§9): residual
   * module-instance memory across reloads is engine reality — the host does
   * not solve it; memory telemetry is the detector.
   */
  readonly reloadExtension: (
    id: string,
    ext: Extension,
    opts?: LifecycleOperationOpts,
  ) => Promise<ReloadResult>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatUnmetDeps(id: string, missing: readonly string[]): string {
  const list = missing.map((d) => `"${d}"`).join(", ");
  const verb = missing.length === 1 ? "is" : "are";
  return `Extension "${id}" depends on ${list}, which ${verb} not loaded`;
}

export function createHost(extensions: readonly Extension[], deps: HostDeps): Host {
  const tools = new Map<string, ToolContract>();
  const providers = new Map<string, ProviderContract>();
  const authProviders = new Map<string, AuthContract>();
  const scheduledJobs: ScheduledJob[] = [];
  const migrations: string[] = [];
  const disabled: DisabledExtension[] = [];
  const activated: Extension[] = [];
  const ledger = new ExtensionLedger();

  const ordered = resolveActivationOrder(extensions.map((e) => e.manifest));
  const extById = new Map<string, Extension>();
  for (const ext of extensions) {
    extById.set(ext.manifest.id, ext);
  }

  const compatible: Extension[] = [];
  for (const m of ordered) {
    const ext = extById.get(m.id);
    if (ext === undefined) continue;
    if (isApiVersionCompatible(m.apiVersion, KERNEL_API_VERSION)) {
      compatible.push(ext);
    } else {
      recordDisabled({
        manifest: m,
        reason: `apiVersion "${m.apiVersion}" is incompatible with kernel API ${KERNEL_API_VERSION}`,
      });
      deps.logger.warn(`Extension "${m.id}" disabled: apiVersion incompatible`);
    }
  }

  for (const ext of compatible) {
    const extMigrations = ext.manifest.contributes?.migrations;
    if (extMigrations) {
      for (const migration of extMigrations) {
        migrations.push(migration);
      }
    }
  }

  function buildHostAPI(
    extensionId: string,
    opts?: { readonly registrationClosed?: boolean },
  ): HostAPI {
    const closed = opts?.registrationClosed ?? false;
    const extLogger = createLogger({ extensionId }, deps.logSink, deps.logDeps);
    return {
      defineTool(tool: ToolContract) {
        if (closed) throw new Error("Registration not available after activation");
        ledger.trackTool(extensionId, tool.name);
        tools.set(tool.name, tool);
      },
      defineProvider(provider: ProviderContract) {
        if (closed) throw new Error("Registration not available after activation");
        ledger.trackProvider(extensionId, provider.id);
        providers.set(provider.id, provider);
      },
      defineAuth(auth: AuthContract) {
        if (closed) throw new Error("Registration not available after activation");
        ledger.trackAuth(extensionId, auth.id);
        authProviders.set(auth.id, auth);
      },
      on<TPayload>(hook: EventHookDescriptor<TPayload>, handler: EventHandler<TPayload>) {
        const dispose = deps.bus.on(hook, handler);
        return ledger.trackDisposal(extensionId, "subscription", hook.id, dispose);
      },
      emit<TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) {
        deps.bus.emit(hook, payload);
      },
      addFilter<TValue>(hook: FilterDescriptor<TValue>, fn: FilterHandler<TValue>) {
        const dispose = deps.bus.addFilter(hook, fn);
        return ledger.trackDisposal(extensionId, "filter", hook.id, dispose);
      },
      async applyFilters<TValue>(
        hook: FilterDescriptor<TValue>,
        value: TValue,
        opts?: { readonly failClosed?: boolean },
      ): Promise<TValue> {
        return deps.bus.applyFilters(hook, value, opts);
      },
      provideService<T>(handle: ServiceHandle<T>, impl: T) {
        const unprovide = deps.bus.provideService(handle, impl);
        return ledger.trackDisposal(extensionId, "service", handle.id, unprovide);
      },
      getService<T>(handle: ServiceHandle<T>): T {
        return deps.bus.getService(handle);
      },
      tryGetService<T>(handle: ServiceHandle<T>): T | undefined {
        return deps.bus.tryGetService(handle);
      },
      onServiceAvailable<T>(handle: ServiceHandle<T>, cb: (impl: T) => void) {
        const dispose = deps.bus.onServiceAvailable(handle, cb);
        return ledger.trackDisposal(extensionId, "subscription", handle.id, dispose);
      },
      onServiceUnavailable<T>(handle: ServiceHandle<T>, cb: () => void) {
        const dispose = deps.bus.onServiceUnavailable(handle, cb);
        return ledger.trackDisposal(extensionId, "subscription", handle.id, dispose);
      },
      storage(namespace: string): StorageNamespace {
        return deps.storageFactory(namespace);
      },
      config: deps.config,
      secrets: deps.secrets,
      permissions: deps.permissions,
      events: deps.events,
      logger: extLogger,
      getProviders() {
        return providers;
      },
      getTools() {
        return tools;
      },
      getAuthProviders() {
        return authProviders;
      },
      getAuthProvider(id: string) {
        return authProviders.get(id);
      },
      getExtensions() {
        return Object.freeze(activated.map((e) => e.manifest));
      },
      scheduler: {
        register(job: ScheduledJob) {
          scheduledJobs.push(job);
          deps.scheduler.register(job);
          ledger.trackJob(extensionId, job.id);
        },
        unregister(jobId: string) {
          unregisterJobInternal(extensionId, jobId);
        },
      },
    };
  }

  /** Remove a job everywhere: host list, injected scheduler, ledger. */
  function unregisterJobInternal(extensionId: string | undefined, jobId: string): void {
    for (let i = scheduledJobs.length - 1; i >= 0; i--) {
      if (scheduledJobs[i]?.id === jobId) scheduledJobs.splice(i, 1);
    }
    deps.scheduler.unregister(jobId);
    if (extensionId !== undefined) ledger.untrackJob(extensionId, jobId);
  }

  /**
   * Disposal contract enforcement (§9): after `deactivate()`, verify every
   * tracked registration for this id is actually gone. Disposal-capable
   * registrations (services, subscriptions, filters, jobs) that the
   * extension did not dispose itself are force-cleaned and logged as
   * "dangling registration from plugin X". Tools/providers/auth have no
   * extension-side removal — the host removes them here as the normal
   * unload sweep (not dangling). Drops the ledger entry either way.
   */
  function enforceDisposal(extensionId: string): DanglingRegistration[] {
    const dangling: DanglingRegistration[] = [];
    const entry = ledger.getEntry(extensionId);
    if (entry !== undefined) {
      for (const disposal of entry.disposals) {
        if (!disposal.isDisposed()) {
          disposal.dispose(); // force-clean (idempotent)
          dangling.push({ kind: disposal.kind, id: disposal.id });
        }
      }
      for (const jobId of [...entry.jobs]) {
        if (scheduledJobs.some((j) => j.id === jobId)) {
          unregisterJobInternal(extensionId, jobId);
          dangling.push({ kind: "job", id: jobId });
        }
      }
      for (const d of dangling) {
        deps.logger.warn(`dangling registration from plugin "${extensionId}": ${d.kind} "${d.id}"`);
      }
      // Host-owned kinds: no extension-side removal exists, so the host
      // removes them as part of the sweep.
      for (const name of entry.tools) tools.delete(name);
      for (const id of entry.providers) providers.delete(id);
      for (const id of entry.auth) authProviders.delete(id);
    }
    ledger.remove(extensionId);
    return dangling;
  }

  /** Keep the latest failure for each extension id, preserving list order. */
  function recordDisabled(entry: DisabledExtension): void {
    const idx = disabled.findIndex((d) => d.manifest.id === entry.manifest.id);
    if (idx === -1) disabled.push(entry);
    else disabled[idx] = entry;
  }

  /** A successful load supersedes any stale disabled-with-reason entry. */
  function clearDisabledFor(id: string): void {
    const idx = disabled.findIndex((d) => d.manifest.id === id);
    if (idx !== -1) disabled.splice(idx, 1);
  }

  /** Activate one extension; on failure sweep its partial registrations. */
  async function activateOne(
    ext: Extension,
  ): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      await ext.activate(buildHostAPI(ext.manifest.id));
      activated.push(ext);
      deps.logger.info(`Extension "${ext.manifest.id}" activated`);
      return { ok: true };
    } catch (err) {
      // Never leave the system broken: the failed activation may have
      // registered things before throwing — sweep them (disposal contract).
      enforceDisposal(ext.manifest.id);
      return { ok: false, error: err };
    }
  }

  /** Transitive dependents of `id` among loaded extensions (activation order). */
  function dependentClosure(id: string): Extension[] {
    const closure = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of activated) {
        if (closure.has(e.manifest.id)) continue;
        const extDeps = e.manifest.dependsOn ?? [];
        if (extDeps.includes(id) || extDeps.some((d) => closure.has(d))) {
          closure.add(e.manifest.id);
          changed = true;
        }
      }
    }
    return activated.filter((e) => closure.has(e.manifest.id));
  }

  async function loadExtension(ext: Extension): Promise<LoadResult> {
    const m = ext.manifest;
    if (activated.some((e) => e.manifest.id === m.id)) {
      return {
        ok: false,
        reason: `Extension "${m.id}" is already loaded; use reloadExtension to replace it`,
      };
    }
    if (!isApiVersionCompatible(m.apiVersion, KERNEL_API_VERSION)) {
      const entry: DisabledExtension = {
        manifest: m,
        reason: `apiVersion "${m.apiVersion}" is incompatible with kernel API ${KERNEL_API_VERSION}`,
      };
      recordDisabled(entry);
      deps.logger.warn(`Extension "${m.id}" disabled: apiVersion incompatible`);
      return { ok: false, reason: entry.reason, disabled: entry };
    }
    // Non-throwing DAG mode: every dependsOn target must be currently
    // loaded (not merely present somewhere) — unmet deps are reported,
    // never thrown.
    const resolution = resolveActivationOrderSafe([m], {
      satisfied: activated.map((e) => e.manifest.id),
    });
    const unmet = resolution.unmet.find((u) => u.manifest.id === m.id);
    if (unmet !== undefined && unmet.missing.length > 0) {
      const reason = formatUnmetDeps(m.id, unmet.missing);
      const entry: DisabledExtension = { manifest: m, reason };
      recordDisabled(entry);
      deps.logger.warn(`Extension "${m.id}" disabled: ${reason}`);
      return { ok: false, reason, disabled: entry };
    }
    const result = await activateOne(ext);
    if (!result.ok) {
      const reason = `Activation failed: ${errText(result.error)}`;
      const entry: DisabledExtension = { manifest: m, reason };
      recordDisabled(entry);
      deps.logger.error(`Extension "${m.id}" failed to activate`, { err: result.error });
      return { ok: false, reason, disabled: entry };
    }
    clearDisabledFor(m.id);
    return { ok: true, manifest: m };
  }

  async function unloadExtension(id: string, opts?: LifecycleOperationOpts): Promise<UnloadResult> {
    const idx = activated.findIndex((e) => e.manifest.id === id);
    if (idx === -1) {
      return { ok: false, id, reason: `Extension "${id}" is not loaded` };
    }
    const ext = activated[idx] as Extension;
    const dependents = activated
      .filter((e) => (e.manifest.dependsOn ?? []).includes(id))
      .map((e) => e.manifest.id);
    if (dependents.length > 0 && opts?.force !== true) {
      return {
        ok: false,
        id,
        reason: `Cannot unload "${id}": ${dependents.length} loaded extension(s) depend on it`,
        blockedBy: dependents,
      };
    }
    let deactivateError: string | undefined;
    if (ext.deactivate !== undefined) {
      try {
        await ext.deactivate();
      } catch (err) {
        deactivateError = errText(err);
        deps.logger.error(`Extension "${id}" failed to deactivate`, { err });
      }
    }
    const dangling = enforceDisposal(id);
    activated.splice(idx, 1);
    deps.logger.info(`Extension "${id}" unloaded`);
    return {
      ok: true,
      id,
      manifest: ext.manifest,
      ...(dangling.length > 0 ? { dangling } : {}),
      ...(deactivateError !== undefined ? { deactivateError } : {}),
    };
  }

  async function reloadExtension(
    id: string,
    ext: Extension,
    opts?: LifecycleOperationOpts,
  ): Promise<ReloadResult> {
    if (ext.manifest.id !== id) {
      return {
        ok: false,
        reason: `Reload target mismatch: expected manifest id "${id}", got "${ext.manifest.id}"`,
      };
    }
    const targetLoaded = activated.some((e) => e.manifest.id === id);
    if (!targetLoaded) {
      // Nothing loaded under this id — reload degenerates to a plain load.
      return loadExtension(ext);
    }
    const dependents = dependentClosure(id); // activation (topological) order
    if (dependents.length > 0 && opts?.force !== true) {
      return {
        ok: false,
        reason: `Cannot reload "${id}": ${dependents.length} loaded extension(s) depend on it`,
        blockedBy: dependents.map((e) => e.manifest.id),
      };
    }
    // Force cascade: unload dependents reverse-topologically (dependents
    // before what they depend on), then the target itself.
    const unloadedDependents: string[] = [];
    for (let i = dependents.length - 1; i >= 0; i--) {
      const dep = dependents[i] as Extension;
      const r = await unloadExtension(dep.manifest.id, { force: true });
      if (r.ok) unloadedDependents.push(dep.manifest.id);
    }
    const targetUnload = await unloadExtension(id, { force: true });
    // Swap in the fresh instance. If this fails it lands in
    // disabled-with-reason (uniform grammar, §9) — no rollback.
    const load = await loadExtension(ext);
    // Bring the dependents back in topological order. Their deps are either
    // the (reloaded) target or non-cascade extensions that never left.
    const reloadedDependents: string[] = [];
    for (const dep of dependents) {
      const r = await loadExtension(dep);
      if (r.ok) reloadedDependents.push(dep.manifest.id);
    }
    return {
      ...load,
      ...(targetUnload.deactivateError !== undefined
        ? { deactivateError: targetUnload.deactivateError }
        : {}),
      ...(unloadedDependents.length > 0 ? { unloadedDependents } : {}),
      ...(reloadedDependents.length > 0 ? { reloadedDependents } : {}),
    };
  }

  return {
    async activate() {
      for (const ext of compatible) {
        const missing = (ext.manifest.dependsOn ?? []).filter(
          (id) => !activated.some((e) => e.manifest.id === id),
        );
        if (missing.length > 0) {
          const reason = formatUnmetDeps(ext.manifest.id, missing);
          recordDisabled({ manifest: ext.manifest, reason });
          deps.logger.warn(`Extension "${ext.manifest.id}" disabled: ${reason}`);
          continue;
        }
        const result = await activateOne(ext);
        if (!result.ok) {
          recordDisabled({
            manifest: ext.manifest,
            reason: `Activation failed: ${errText(result.error)}`,
          });
          deps.logger.error(`Extension "${ext.manifest.id}" failed to activate`, {
            err: result.error,
          });
        } else {
          clearDisabledFor(ext.manifest.id);
        }
      }
    },
    async deactivate() {
      for (let i = activated.length - 1; i >= 0; i--) {
        const ext = activated[i];
        if (ext === undefined || ext.deactivate === undefined) continue;
        try {
          await ext.deactivate();
        } catch (err) {
          deps.logger.error(`Extension "${ext.manifest.id}" failed to deactivate`, { err });
        }
      }
    },
    getTools() {
      return tools;
    },
    getTool(name: string) {
      return tools.get(name);
    },
    getProviders() {
      return providers;
    },
    getProvider(id: string) {
      return providers.get(id);
    },
    getAuthProviders() {
      return authProviders;
    },
    getAuthProvider(id: string) {
      return authProviders.get(id);
    },
    getScheduledJobs() {
      return scheduledJobs;
    },
    getMigrations() {
      return migrations;
    },
    getDisabled() {
      return disabled;
    },
    getExtensions() {
      return Object.freeze(activated.map((e) => e.manifest));
    },
    getToolOwners() {
      return ledger.toolOwners();
    },
    getProviderOwners() {
      return ledger.providerOwners();
    },
    getHostAPI() {
      return buildHostAPI("__host__", { registrationClosed: true });
    },
    loadExtension,
    unloadExtension,
    reloadExtension,
  };
}
