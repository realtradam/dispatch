/**
 * layout-provider-registry manifest — the per-workspace layout ACTIVATION
 * plane. A bundled STANDARD extension (D-L6: layout is a plugin's domain —
 * the registry holds provider REFERENCES keyed by plugin id and never reads
 * a tree; it is the mechanism, not the domain) that provides the typed
 * `layoutProviderRegistryHandle` every layout plugin registers into and
 * every consumer resolves the workspace-active provider from.
 */

import type { Manifest } from "@dispatch/kernel";

export const manifest: Manifest = {
  id: "layout-provider-registry",
  name: "Layout Provider Registry",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "standard",
  trust: "bundled",
  // The per-workspace enablement plane decides WHICH registered layout
  // plugin serves a workspace — consumed reactively (plan 03): the registry
  // activates anywhere and resolution degrades (404) while the config
  // service is absent. No ordering constraint on the layout plugins
  // themselves either — they register reactively (onServiceAvailable), so
  // activation order is irrelevant (unlike the old single-slot handle,
  // whose first-provider-wins race made bundled order semantic).
  dependsOn: [],
  activation: "eager",
  contributes: {
    services: ["layout/provider-registry"],
  },
};
