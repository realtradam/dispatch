/**
 * layout-chat manifest (plan 02 §2.3) — the bundled STANDARD plugin (D-L3)
 * that owns the default layout. Follows the plugin-scaffold's field-by-field
 * conventions.
 */

import type { Manifest } from "@dispatch/kernel";

export const manifest: Manifest = {
  // Unique id across all loaded plugins; the plugin manager + per-workspace
  // enablement store key everything by it.
  id: "layout-chat",

  name: "Chat Layout",

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
    // The typed service other units (plan-04 op writers, future layout
    // plugins' consumers) consume via `layoutProviderHandle`.
    services: ["layout/provider"],

    // The well-known HTTP routes this plugin OWNS while active (declared for
    // discovery/gating; mounted by the core transport-http over the live
    // registry slot — the route handlers come from the provider kit). While
    // the plugin is active the routes serve; after deactivation they 404.
    routes: ["/workspaces/:id/layout"],
  },

  // No fs/shell/network/secrets/db needs — a storage namespace rides `db`.
  capabilities: { db: true },

  activation: "eager",
};
