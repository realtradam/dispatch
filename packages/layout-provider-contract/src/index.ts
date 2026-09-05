/**
 * `@dispatch/layout-provider-contract` — the backend-only half of the layout
 * contract (plan 02, decision 1): the typed `layoutProviderHandle` service
 * binding, the `layoutChanged` event hook (the WS broadcast path), and the
 * `createLayoutProvider` kit + route handlers every layout plugin composes.
 *
 * Touches kernel types (`ServiceHandle`, `StorageNamespace`, `Logger`) the
 * frontend must never depend on — the frontend consumes ONLY
 * `@dispatch/layout-contract` (the pure schema) + the wire types.
 */

export { layoutChanged, layoutProviderHandle } from "./handle";
export {
  createLayoutProvider,
  createLayoutRouteHandlers,
  type LayoutProviderDeps,
  type LayoutRouteHandlers,
  type LayoutRouteResult,
  parseOpsBody,
  parseTreeBody,
} from "./kit";
