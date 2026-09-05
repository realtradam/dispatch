/**
 * layout-diagnostic manifest — the bundled STANDARD plugin (D-L3/D-L6) that
 * provides a DIAGNOSTIC layout: exactly the default layout with a visible
 * border on each root tile, so a human can see which tile is which. Mirrors
 * the layout-chat manifest field-by-field — it is the same KIND of plugin
 * (a layout provider built from the plan-02 kit), with a different tree.
 */

import type { Manifest } from "@dispatch/kernel";

export const manifest: Manifest = {
  // Unique id across all loaded plugins; the plugin manager + per-workspace
  // enablement store key everything by it.
  id: "layout-diagnostic",

  name: "Diagnostic Layout",

  version: "0.0.0",

  apiVersion: "^0.1.0",

  // Standard (D-L3 / D-L6): layout is a plugin's domain, not core. The tier
  // test: no backend process ever reads a layout tree.
  tier: "standard",

  trust: "bundled",

  // No layout-specific dependsOn (decision 1): this plugin imports the KIT
  // package at build time (`@dispatch/layout-provider-contract`), never
  // another plugin. It needs no other extension's service to activate.
  dependsOn: [],

  contributes: {
    // The typed service other units consume via `layoutProviderHandle` —
    // same handle as every layout provider (exactly one may be active,
    // decision 8: first-provider-wins).
    services: ["layout/provider"],

    // The well-known HTTP routes this plugin OWNS while active (the same
    // routes every layout provider declares — the transport mounts them over
    // the live registry slot, so they follow whoever provides the service).
    routes: ["/workspaces/:id/layout", "/workspaces/:id/layout/ops"],
  },

  // No fs/shell/network/secrets/db needs — a storage namespace rides `db`.
  capabilities: { db: true },

  activation: "eager",
};
