// @dispatch/agent-management — the standard extension that exposes an
// AI-callable tool family for starting and managing agent conversations.
//
// Exports the extension (manifest + activate), the typed
// AgentManagementService handle + factory, the service input/output types, and
// the pure decision helpers (for direct testing).

export { extension, manifest } from "./extension.js";
export {
  type AccessOperation,
  decideAccess,
  extractLastAssistantReply,
  extractLastError,
  filterModelEntries,
  formatFileAttachments,
  heuristicVisionCapable,
  resolveShortId,
  resolveVision,
  type ShortIdResolution,
  shortId,
  truncateText,
} from "./pure.js";
export {
  type AgentManagementDeps,
  type AgentManagementService,
  agentManagementHandle,
  type CancelAgentMessageInput,
  type CancelAgentMessageResult,
  createAgentManagementService,
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
  AgentEntry,
  AgentManagementError,
  AgentManagementErrorCode,
  ModelEntry,
  Result,
} from "./types.js";
