/**
 * The workspace-plugin-config PUBLIC service handle — the typed
 * cross-extension surface (AGENTS.md: cross-extension coupling is anchored
 * to exported TYPED symbols). Kept separate from `service.ts` so consumers
 * (session-orchestrator's tool gate, transport-http, transport-ws) never
 * import the implementation.
 */

import { defineService } from "@dispatch/kernel";
import type { WorkspacePluginConfigService } from "./service.js";

/**
 * Typed service handle the workspace-plugin-config core extension provides
 * and every per-workspace enforcement point consumes. Consumed REACTIVELY
 * (plan 03 — `tryGetService` / availability slots): the config store is
 * always present in practice (tier core), but consumers degrade open when
 * it is absent rather than hard-failing a turn/route.
 */
export const workspacePluginConfigHandle = defineService<WorkspacePluginConfigService>(
  "workspace-plugin-config/store",
);
