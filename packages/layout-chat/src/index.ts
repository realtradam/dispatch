/**
 * `@dispatch/layout-chat` — the bundled STANDARD plugin that owns the default
 * layout (plan 02, D-L3): per-workspace trees in its own storage namespace,
 * the well-known `/workspaces/:id/layout` HTTP routes, and the `layout` WS
 * change broadcast — all built from the generic core machinery via the
 * `@dispatch/layout-provider-contract` kit.
 */

export { activate, extension, manifest } from "./extension";
