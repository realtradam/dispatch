import { defineService, type ServiceHandle } from "@dispatch/kernel";
import type { ComputerStatusResponse, TestComputerResponse } from "@dispatch/transport-contract";
import type { Computer, ComputerEntry } from "@dispatch/wire";

export type { ConversationStore } from "@dispatch/conversation-store";
export { conversationStoreHandle, isValidWorkspaceSlug } from "@dispatch/conversation-store";
export type { CredentialStore } from "@dispatch/credential-store";
export { credentialStoreHandle } from "@dispatch/credential-store";
export type { HeartbeatService } from "@dispatch/heartbeat";
export { heartbeatServiceHandle } from "@dispatch/heartbeat";
export type { LspServerStatus, LspService } from "@dispatch/lsp";
export { lspServiceHandle } from "@dispatch/lsp";
export type { McpServerStatus, McpService } from "@dispatch/mcp";
export { mcpServiceHandle } from "@dispatch/mcp";
export type { NamedAgentsService } from "@dispatch/named-agents";
export { namedAgentServiceHandle } from "@dispatch/named-agents";
export type { FrontendEntryResult, PluginManagerService } from "@dispatch/plugin-manager";
export { pluginManagerHandle } from "@dispatch/plugin-manager";
export type { ConcurrencyService } from "@dispatch/provider-concurrency";
export { concurrencyServiceHandle } from "@dispatch/provider-concurrency";
export type {
  CompactionService,
  PluginOwnership,
  SessionOrchestrator,
  WarmService,
} from "@dispatch/session-orchestrator";
export {
  cacheWarmHandle,
  compactionHandle,
  conversationOpened,
  pluginOwnershipHandle,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
export type { SystemPromptService } from "@dispatch/system-prompt";
export { systemPromptHandle } from "@dispatch/system-prompt";
export type { ThroughputStore } from "@dispatch/throughput-store";
export { ThroughputQueryError, throughputStoreHandle } from "@dispatch/throughput-store";
export type { SearchConfigService } from "@dispatch/tool-web-search";
export { searchConfigServiceHandle } from "@dispatch/tool-web-search";
export type { WorkspacePluginConfigService } from "@dispatch/workspace-plugin-config";
export {
  usablePluginsInWorkspace,
  workspacePluginConfigHandle,
} from "@dispatch/workspace-plugin-config";

// ─── ComputerService seam ─────────────────────────────────────────────────────
//
// The read-only computer discovery + live connection surface. The `ssh`
// extension provides the real implementation (parses `~/.ssh/config`, pools
// `ssh2` connections) and registers it via `host.provideService`. Until ssh is
// loaded, the routes that delegate here DEGRADE: the list route returns an empty
// `[]` (no computers configured), and the status/test routes return their
// "disconnected" / not-configured sentinels. The interface + handle are defined
// HERE (not in `@dispatch/ssh`, which does not exist yet) so the routes can be
// wired against a typed seam today; when the `ssh` package lands it imports
// `ComputerService` + `computerServiceHandle` from here (mirroring how a
// provider implements a contract owned by its consumer seam).

/**
 * Read-only computer discovery + per-alias live state + one-shot probe. The
 * transport routes delegate to this; it never throws for "no ssh configured"
 * — an ABSENT service (ssh extension not loaded) is the graceful-degrade path.
 */
export interface ComputerService {
  /** Every computer discovered from `~/.ssh/config`, sorted by `alias`. */
  readonly listComputers: () => Promise<readonly ComputerEntry[]>;
  /** One computer by alias, or `null` when the alias isn't in the config. */
  readonly getComputer: (alias: string) => Promise<Computer | null>;
  /** Live connection state for a computer alias. */
  readonly getStatus: (alias: string) => Promise<ComputerStatusResponse>;
  /** One-shot connectivity probe (open, run a trivial command, close). */
  readonly test: (alias: string) => Promise<TestComputerResponse>;
}

/**
 * Typed service handle the `ssh` extension provides and the transport routes
 * consume. Mirrors `lspServiceHandle` / `mcpServiceHandle`.
 */
export const computerServiceHandle: ServiceHandle<ComputerService> =
  defineService<ComputerService>("ssh");

// ─── Layout provider REGISTRY seam (plan 02, evolved: per-workspace activation) ──
//
// The layout-provider REGISTRY (a STANDARD extension —
// `layout-provider-registry` — provides it; every loaded layout plugin
// registers its provider under its plugin id). Consumed REACTIVELY like
// every optional Standard service: the routes resolve the WORKSPACE's one
// enabled layout plugin per request (`providerFor(workspaceId)`) and 404
// while the workspace has none (the frontend's no-provider signal); a
// mid-session load or enablement change applies to the next request with no
// restart. The route DECISION logic (status mapping, body validation) lives
// in the provider kit (`@dispatch/layout-provider-contract`) — the transport
// mounts the handlers as thin shells and learns nothing about trees (D-L6).

export type { LayoutProvider } from "@dispatch/layout-contract";
export {
  type LayoutProviderRegistry,
  layoutProviderRegistryHandle,
} from "@dispatch/layout-provider-contract";

// ─── Home tile-layout seam (the workspace home grid's synced layouts) ────────
//
// The home tile-layout SERVICE (a STANDARD extension — `home-tile-layout` —
// provides it; ONE shared document per device orientation, wide/tall).
// Consumed REACTIVELY like every optional Standard service: the routes resolve
// the service per request and 503 while it is absent (a mid-session
// load/unload applies to the next request with no restart). The route
// DECISION logic (mode validation, body parsing, status mapping) lives in the
// contract kit (`@dispatch/home-tile-layout-contract`) — the transport mounts
// the handlers as thin shells and learns nothing about tile documents (D-L6).

export type { HomeTileLayoutService } from "@dispatch/home-tile-layout-contract";
export { homeTileLayoutHandle } from "@dispatch/home-tile-layout-contract";
