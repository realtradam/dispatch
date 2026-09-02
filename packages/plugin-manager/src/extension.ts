/**
 * plugin-manager extension — the plugin system's runtime CONTROL PLANE
 * (plan 05): a CORE extension that owns the override-record store and
 * exposes the list / scan / load / unload / reload operations as a typed
 * service for the transport layer.
 *
 * Tier: core — the manager must never be runtime-unloadable (it IS the
 * load/unload machinery's control plane; user-confirmed classification,
 * plan 00). It consumes the host engine + discovery through the
 * consumer-defined `PluginEngine` handle (provided by the composition root
 * before activation) and the session-orchestrator reactively (`stopAll` for
 * forced unloads, §8).
 *
 * Runtime credentials — v1 LIMITATION (plan 00 Q-C, resolved: document, do
 * NOT build): the credential store is assembled once at boot from env vars.
 * A provider plugin loaded mid-session surfaces a credential ONLY if its env
 * var was present at boot; otherwise it lands in disabled-with-reason
 * ("missing credential"). No runtime register/unregister API, no UI-entered
 * keys — user-facing copy must present this as a known limitation, not a
 * bug. Dependents are NOT auto-retried either (documented v1 behavior): if
 * plugin A failed to load because dependency B was absent, loading B later
 * does NOT retry A — the user re-loads A from the manager (A shows in
 * disabled-with-reason "depends on B"). Neither is a stuck state.
 */

import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { sessionOrchestratorHandle } from "@dispatch/session-orchestrator";
import { pluginEngineHandle } from "./engine.js";
import { PLUGIN_OVERRIDES_NAMESPACE } from "./overrides.js";
import { createPluginManagerService } from "./service.js";
import { extensionsChanged, pluginManagerHandle } from "./service-handle.js";

export const manifest: Manifest = {
  id: "plugin-manager",
  name: "Plugin Manager",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "core",
  trust: "bundled",
  activation: "eager",
  capabilities: { db: true },
  contributes: {
    services: ["plugin-manager/manager"],
    hooks: ["plugin-manager/extensions-changed"],
  },
};

/** The availability-subscription disposer (disposed on deactivate). */
let watchDisposer: (() => void) | undefined;

export function activate(host: HostAPI): void {
  // Mandatory core→core engine handle — the composition root provides it
  // deterministically before host.activate(); a missing provider fails
  // activation loudly (the manager cannot do its job without the engine).
  const engine = host.getService(pluginEngineHandle);
  const storage = host.storage(PLUGIN_OVERRIDES_NAMESPACE);

  // The orchestrator is consumed REACTIVELY (plan 03): `stopAll` is only
  // needed on forced unloads, so an absent orchestrator degrades to
  // "zero agents stopped" instead of blocking the manager.
  let orchestrator: { readonly stopAll: () => { readonly stopped: number } } | undefined =
    host.tryGetService(sessionOrchestratorHandle);
  watchDisposer = host.onServiceAvailable(sessionOrchestratorHandle, (impl) => {
    orchestrator = impl;
  });

  const service = createPluginManagerService({
    engine,
    storage,
    logger: host.logger,
    now: () => new Date().toISOString(),
    emitExtensionsChanged: (message) => host.emit(extensionsChanged, message),
    stopAllAgents: () => orchestrator?.stopAll() ?? { stopped: 0 },
  });

  host.provideService(pluginManagerHandle, service);
  host.logger.info("plugin-manager: activated");
}

export const extension: Extension = {
  manifest,
  activate,
  deactivate() {
    // Disposal contract: dispose the availability subscription this
    // extension created (the ledger-wrapped disposer is idempotent).
    watchDisposer?.();
    watchDisposer = undefined;
  },
};
