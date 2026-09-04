/**
 * The layout-provider contract's PUBLIC typed symbols (plan 02 §2.2) — the
 * service handle every layout plugin provides and the change hook the
 * transport broadcasts. Kept OUT of any providing plugin's own package so no
 * layout plugin ever imports another's (consumers and providers both import
 * THIS package).
 *
 * Backend-only: touches kernel types (`ServiceHandle`, `StorageNamespace`)
 * the frontend must never depend on (decision 1 — two contract packages).
 */

import { defineEventHook, defineService, type ServiceHandle } from "@dispatch/kernel";
import type { LayoutProvider } from "@dispatch/layout-contract";
import type { LayoutChangedMessage } from "@dispatch/transport-contract";

/**
 * The typed service binding for the ACTIVE layout provider. Exactly one
 * provider should be provided at a time (decision 8): the kernel's registry
 * is first-provider-wins — a second `provideService` on this handle throws,
 * which fails that plugin's activation into the manager's
 * disabled-with-reason grammar.
 */
export const layoutProviderHandle: ServiceHandle<LayoutProvider> =
  defineService<LayoutProvider>("layout/provider");

/**
 * Fired after every successful layout write (PUT / setTree / DELETE / the
 * plan-04 ops) by the active provider. The payload IS the wire message —
 * transport-ws broadcasts it to ALL connected frontends verbatim (§11
 * multi-client coherence); clients filter by their active workspace. This is
 * the `extensions-changed` path: a typed event hook, additive to the wire,
 * zero layout knowledge in the transport.
 */
export const layoutChanged = defineEventHook<LayoutChangedMessage>("layout/layout-changed");
