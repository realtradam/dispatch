/**
 * The plugin-ownership seam (plan 06 §6.3) — a consumer-defined typed
 * service handle (the `pluginEngineHandle` pattern): session-orchestrator
 * defines WHAT it needs, the composition root (`host-bin/src/main.ts`)
 * implements it from the kernel Host's plan-01 registration-ledger views
 * (`getToolOwners` / `getProviderOwners`) and provides it BEFORE
 * `host.activate()`.
 *
 * Why a seam: the ledger lives inside the kernel host — an extension's
 * HostAPI cannot see it. The composition root owns the Host object, so it
 * is the one unit that can adapt the ledger into a service. Attribution
 * via the ledger is AUTHORITATIVE (it records every `defineTool` /
 * `defineProvider` under the caller's extension id — including
 * filter-injected tools with runtime names no manifest can enumerate, e.g.
 * MCP's `<serverId>__<toolName>`), so it cannot drift from reality.
 *
 * Consumers (session-orchestrator's tool gate, transport-http's
 * `/models` workspace filter + model-usability check, transport-ws's
 * surface-catalog filter) read it REACTIVELY (plan 03 — `tryGetService`):
 * absent → the workspace gates degrade open (fail-open) rather than
 * blocking turns.
 */

import { defineService, type ServiceHandle } from "@dispatch/kernel";

export interface PluginOwnership {
  /**
   * The extension id that registered the named tool via `defineTool`, or
   * `undefined` when the tool has no ledger entry (unattributable).
   */
  readonly ownerOfTool: (toolName: string) => string | undefined;
  /**
   * The extension id that registered the provider id via `defineProvider`,
   * or `undefined` when the provider has no ledger entry.
   */
  readonly ownerOfProvider: (providerId: string) => string | undefined;
}

export const pluginOwnershipHandle: ServiceHandle<PluginOwnership> = defineService<PluginOwnership>(
  "session-orchestrator/plugin-ownership",
);
