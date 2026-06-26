/**
 * Barrel export — the public surface of @dispatch/cli.
 *
 * Pure functions + http functions for consumers and tests.
 */

export { type ParsedCommand, parseArgs } from "./args.js";
export { formatCatalog } from "./catalog.js";
export {
  type ConversationIdResolution,
  enqueueMessage,
  fetchConversations,
  fetchLastMessage,
  fetchModels,
  openConversation,
  resolveConversationId,
  streamChat,
} from "./http.js";
export { buildChatRequest, composeMessage } from "./message.js";
export { type SplitResult, splitNdjsonLines } from "./ndjson.js";
export {
  extractLastText,
  formatConversationList,
  formatRelativeTime,
  renderEvent,
} from "./render.js";
