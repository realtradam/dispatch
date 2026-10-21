export type { StoredChunk } from "@dispatch/kernel";
export { extension, manifest } from "./extension.js";
export { initializeConversationListIndex } from "./list-index.js";
export type { ReconcileReport, ReconcileResult } from "./reconcile.js";
export { reconcile, reconcileWithReport } from "./reconcile.js";
// Pure repair helpers for corrupted transcripts (duplicate tool-call chunks).
export type { DedupeResult } from "./repair.js";
export { countChunks, dedupeDuplicateToolChunks } from "./repair.js";
export type {
  ConversationDeletedPayload,
  ConversationExclusive,
  ConversationStore,
} from "./store.js";
export {
  conversationDeleted,
  conversationStoreHandle,
  createConversationStore,
  extractTitle,
  isValidWorkspaceSlug,
  parseNamedAgentSelectionSnapshot,
} from "./store.js";
