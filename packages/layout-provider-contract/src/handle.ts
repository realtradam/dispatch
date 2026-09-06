/**
 * The layout-provider contract's PUBLIC typed symbols (plan 02 §2.2, evolved
 * for per-workspace activation) — the service registry handle layout plugins
 * register into and consumers resolve the workspace-active provider from,
 * plus the change hook the transport broadcasts. Kept OUT of any providing
 * plugin's own package so no layout plugin ever imports another's (providers
 * and consumers both import THIS package).
 *
 * Backend-only: touches kernel types (`ServiceHandle`) the frontend must
 * never depend on (decision 1 — two contract packages).
 */

import { defineEventHook, defineService, type ServiceHandle } from "@dispatch/kernel";
import type { LayoutChangedMessage } from "@dispatch/transport-contract";
import type { LayoutProviderRegistry } from "./registry";

/**
 * The typed service binding for the layout-provider REGISTRY. Every loaded
 * layout plugin registers its provider here (under its own plugin id); the
 * ONE provider that serves a workspace is decided PER WORKSPACE from the
 * per-workspace enablement state — multiple layout plugins coexist loaded,
 * exactly one is active per workspace (the per-workspace activation rule
 * that supersedes the old single-slot, first-provider-wins handle: a global
 * slot cannot express per-workspace selection).
 */
export const layoutProviderRegistryHandle: ServiceHandle<LayoutProviderRegistry> =
  defineService<LayoutProviderRegistry>("layout/provider-registry");

/**
 * Fired after every successful layout write (PUT / setTree / DELETE / the
 * plan-04 ops) by the workspace-active provider. The payload IS the wire
 * message — transport-ws broadcasts it to ALL connected frontends verbatim
 * (§11 multi-client coherence); clients filter by their active workspace.
 * This is the `extensions-changed` path: a typed event hook, additive to the
 * wire, zero layout knowledge in the transport.
 */
export const layoutChanged = defineEventHook<LayoutChangedMessage>("layout/layout-changed");
