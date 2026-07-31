// @dispatch/agent-management — the standard extension that exposes an
// AI-callable tool family for starting and managing agent conversations.
//
// Exports the extension (manifest + activate), the typed
// AgentManagementService handle + factory, the service input/output types, and
// the pure decision helpers (for direct testing).

export { extension, manifest } from "./extension.js";
export {
  agentManagementHandle,
  createAgentManagementService,
  type AgentManagementDeps,
  type AgentManagementService,
  type CancelAgentMessageInput,
  type CancelAgentMessageResult,
  type ListAgentsInput,
  type ListAgentsResult,
  type ListModelsInput,
  type ListModelsResult,
  type OpenAgentInput,
  type OpenAgentResult,
  type ReadAgentInput,
  type ReadAgentResult,
  type SendAgentInput,
  type SendAgentResult,
  type SummonAgentInput,
  type SummonAgentResult,
} from "./service.js";
export type {
  AgentManagementError,
  AgentManagementErrorCode,
  ModelEntry,
  AgentEntry,
  Result,
} from "./types.js";
export {
  decideAccess,
  extractLastAssistantReply,
  extractLastError,
  filterModelEntries,
  formatFileAttachments,
  heuristicVisionCapable,
  resolveShortId,
  resolveVision,
  shortId,
  truncateText,
  type AccessOperation,
  type ShortIdResolution,
} from "./pure.js";
