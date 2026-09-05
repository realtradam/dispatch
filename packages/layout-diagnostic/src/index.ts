/**
 * `@dispatch/layout-diagnostic` — the bundled STANDARD plugin that provides a
 * DIAGNOSTIC layout (plan 02 machinery, D-L3/D-L6): the default tile tree
 * with a visible border marker on each root tile (main = red, side = green),
 * built from the same `@dispatch/layout-provider-contract` kit as
 * layout-chat. Purely for looking at — it owns per-workspace trees in its
 * own storage namespace, serves the well-known `/workspaces/:id/layout`
 * routes, and broadcasts `layout` WS changes while it is the active provider.
 */

export { activate, extension, manifest } from "./extension";
export { DIAGNOSTIC_LAYOUT, deriveDiagnosticLayout } from "./tree";
