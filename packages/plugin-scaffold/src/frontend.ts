/**
 * plugin-scaffold — the CANONICAL example FRONTEND module (plan 03).
 *
 * This file is the reference a frontend-plugin author copies. It is built to
 * a SINGLE standalone ESM file (`bun run build:frontend` — the vite lib
 * config `scaffold-frontend.config.ts` next to this file, with the whole
 * `svelte` package EXTERNALIZED), producing `frontend.js` at the package
 * root: the file the manifest's `frontend.entry` names and the backend
 * serves at `GET /plugins/plugin-scaffold/frontend`.
 *
 * The contract (plan 03 §3.2):
 * - the module DEFAULT-EXPORTS `{ activate(api) }`;
 * - `activate` registers views through the host API it receives — pluginId
 *   attribution is FORCED by the host (you cannot misattribute);
 * - it MAY return a deactivate disposer — run on unload/disable BEFORE the
 *   host's unregister-by-pluginId sweep (the sweep is the safety net);
 * - views get data via `api.surfaces` (backend surfaces — the ui-contract
 *   data path), never via app internals;
 * - HONEST LIMITATION: ESM cannot be un-fetched. On unload the bytes linger
 *   in the browser's module cache; re-enabling re-runs `activate` on the
 *   cached module (same URL ⇒ no re-fetch). A backend-side reload changes
 *   the content bust ⇒ a NEW URL ⇒ a fresh module instance.
 * - Svelte is the host's runtime (an import map resolves the externalized
 *   `svelte` specifiers to the app's own copy) — never bundle svelte.
 */

// The view compiles against the SHARED svelte runtime (externalized at
// build time) — see `scaffold-view.svelte` for the minimal runes example.
import ScaffoldView from "./scaffold-view.svelte";

/** The host API shape (structural — the ABI contract lives in the web repo). */
interface FrontendHostAPI {
  readonly abiVersion: string;
  registerView(reg: {
    id: string;
    label: string;
    // biome-ignore lint/suspicious/noExplicitAny: the registry is a heterogeneous component bag
    component: any;
    panelEligible?: boolean;
  }): () => void;
  readonly surfaces: {
    subscribe(surfaceId: string, conversationId?: string): void;
    unsubscribe(surfaceId: string, conversationId?: string): void;
    invoke(surfaceId: string, actionId: string, payload?: unknown, conversationId?: string): void;
    getSpec(surfaceId: string): unknown;
  };
  readonly logger: { info(msg: string): void; warn(msg: string): void };
}

export default {
  activate(api: FrontendHostAPI): () => void {
    api.logger.info(`plugin-scaffold frontend activated (host ABI ${api.abiVersion})`);

    // Register the view into the SAME registry built-ins use. The id is what
    // a tile leaf's `view` field names — place it via a layout plugin (plan
    // 02's layout-chat) or a panel dropdown. panelEligible defaults to true.
    const disposeView = api.registerView({
      id: "plugin-scaffold",
      label: "Plugin Scaffold",
      component: ScaffoldView,
    });

    // Per-call state lives in the activate closure (no module state) — the
    // disposer below is the deactivate contract.
    return () => {
      disposeView();
      api.logger.info("plugin-scaffold frontend deactivated");
    };
  },
};
