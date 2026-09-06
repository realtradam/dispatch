/**
 * `@dispatch/layout-provider-contract` — the backend-only half of the layout
 * contract (plan 02, decision 1): the typed `layoutProviderRegistryHandle`
 * service binding (per-workspace layout activation), the `layoutChanged`
 * event hook (the WS broadcast path), the per-workspace provider RESOLUTION
 * (`LayoutProviderRegistry` + `selectLayoutPlugin`), and the
 * `createLayoutProvider` kit + route handlers every layout plugin composes.
 *
 * Touches kernel types (`ServiceHandle`, `StorageNamespace`, `Logger`) the
 * frontend must never depend on — the frontend consumes ONLY
 * `@dispatch/layout-contract` (the pure schema) + the wire types.
 */

export { layoutChanged, layoutProviderRegistryHandle } from "./handle";
export {
  createLayoutProvider,
  createLayoutRouteHandlers,
  type LayoutProviderDeps,
  type LayoutRouteHandlers,
  type LayoutRouteResult,
  parseOpsBody,
  parseTreeBody,
} from "./kit";
export {
  createLayoutProviderRegistry,
  type LayoutPluginSelection,
  type LayoutProviderRegistry,
  type LayoutProviderRegistryDeps,
  selectLayoutPlugin,
} from "./registry";
