/**
 * home-tile-layout manifest — the bundled STANDARD plugin that owns the
 * workspace home grid's synced layout documents (one per device orientation,
 * wide/tall, in its own storage namespace), serves the well-known
 * /home/tile-layout/:mode routes through transport-http, and broadcasts
 * `tile-layout` WS changes.
 */

import type { Manifest } from "@dispatch/kernel";

export const manifest: Manifest = {
  // Unique id across all loaded plugins; the plugin manager keys by it.
  id: "home-tile-layout",

  name: "Home Tile Layout",

  version: "0.0.0",

  apiVersion: "^0.1.0",

  // Standard: the tile layout is a plugin's domain, not core. The tier test:
  // no backend process ever reads a tile-layout document.
  tier: "standard",

  trust: "bundled",

  // No dependsOn: this plugin imports the CONTRACT package at build time
  // (`@dispatch/home-tile-layout-contract`), never another plugin. The
  // transport consumes the service REACTIVELY (tryGetService +
  // onServiceAvailable), so no activation-order edge exists.
  dependsOn: [],

  contributes: {
    // The well-known HTTP routes this plugin OWNS — mounted by transport-http
    // as thin shells over the reactive service lookup (see the transport).
    routes: ["/home/tile-layout/:mode"],
  },

  // No fs/shell/network/secrets needs — a storage namespace rides `db`.
  capabilities: { db: true },

  // Always-on: the home grid is a global surface (no per-workspace
  // enablement — unlike the layout providers, there is nothing to opt into).
  activation: "eager",
};
