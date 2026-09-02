/**
 * The plugin-manager's PUBLIC handles and hook descriptor — the typed
 * cross-extension surface (AGENTS.md: cross-extension coupling is anchored
 * to exported TYPED symbols). Kept separate from `service.ts` so consumers
 * (transport-http, transport-ws) never import the implementation.
 */

import { defineEventHook, defineService, type ServiceHandle } from "@dispatch/kernel";
import type { ExtensionsChangedMessage } from "@dispatch/transport-contract";
import type { PluginManagerService } from "./service.js";

/** Typed service handle the manager provides and the transport routes consume. */
export const pluginManagerHandle: ServiceHandle<PluginManagerService> =
  defineService<PluginManagerService>("plugin-manager/manager");

/**
 * Fired after every manager mutation (load / unload / reload / scan /
 * forget). The payload IS the wire message — transport-ws broadcasts it to
 * ALL connected frontends verbatim (§11 multi-client coherence: extension
 * list + surface catalog refresh everywhere).
 */
export const extensionsChanged = defineEventHook<ExtensionsChangedMessage>(
  "plugin-manager/extensions-changed",
);
