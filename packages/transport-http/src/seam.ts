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
export type {
	CompactionService,
	SessionOrchestrator,
	WarmService,
} from "@dispatch/session-orchestrator";
export {
	cacheWarmHandle,
	compactionHandle,
	conversationOpened,
	sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
export type { SystemPromptService } from "@dispatch/system-prompt";
export { systemPromptHandle } from "@dispatch/system-prompt";
export type { ThroughputStore } from "@dispatch/throughput-store";
export { ThroughputQueryError, throughputStoreHandle } from "@dispatch/throughput-store";

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
