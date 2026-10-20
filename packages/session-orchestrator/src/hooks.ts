export { type ConversationDeletedPayload, conversationDeleted } from "@dispatch/conversation-store";

import {
  type ConversationStatus,
  defineEventHook,
  type EventHookDescriptor,
} from "@dispatch/kernel";
import type { WarmResult } from "./warm.js";

// --- Lifecycle event hooks ---

/** Context carried on turn-lifecycle events, enough to replicate the turn's request prefix. */
export interface TurnLifecyclePayload {
  readonly conversationId: string;
  readonly cwd?: string;
  /** The computer this turn executes on (SSH alias), mirroring `cwd`. */
  readonly computerId?: string;
  readonly modelName?: string;
}

/** Fired when a turn STARTS driving a conversation (consumers cancel warming timers). */
export const turnStarted: EventHookDescriptor<TurnLifecyclePayload> =
  defineEventHook<TurnLifecyclePayload>("session-orchestrator/turn-started");

/** Fired when a turn SETTLES (sealed) for a conversation (consumers arm warming timers). */
export const turnSettled: EventHookDescriptor<TurnLifecyclePayload> =
  defineEventHook<TurnLifecyclePayload>("session-orchestrator/turn-settled");

/** Payload for the conversationClosed bus event. */
export interface ConversationClosedPayload {
  readonly conversationId: string;
}

/**
 * Fired when a client EXPLICITLY closes a conversation (tab close — NOT a mere
 * disconnect). Consumers stop per-conversation background work (e.g. cache-warming
 * disables its schedule). Emitted by `SessionOrchestrator.closeConversation`.
 */
export const conversationClosed: EventHookDescriptor<ConversationClosedPayload> =
  defineEventHook<ConversationClosedPayload>("session-orchestrator/conversation-closed");

/** Payload for the conversationOpened bus event. */
export interface ConversationOpenedPayload {
  readonly conversationId: string;
  /**
   * The conversation's actual persisted workspace id (resolved from the
   * store, not the per-turn start option), so a frontend can open/focus the
   * tab in the correct workspace. Falls back to `"default"`.
   */
  readonly workspaceId: string;
  /**
   * The conversation's persisted per-conversation model (`<credential>/<model>`),
   * when one is set — so a frontend can stamp the newly-opened tab with the
   * conversation's ACTUAL model instead of the currently-selected global model
   * (fix-toolcall-duplicate-keys plan Part 4). Absent = default provider model.
   */
  readonly model?: string;
  /** Effective visual group parent; absent = ungrouped. */
  readonly tabGroupParentId?: string;
}

/**
 * Fired when a client requests to "open" a conversation (e.g. the CLI `--open`
 * flag). Transport-ws subscribes and broadcasts a `conversation.open` WS
 * message to all connected frontend clients. The frontend decides whether to
 * open/focus a tab — the backend just signals.
 */
export const conversationOpened: EventHookDescriptor<ConversationOpenedPayload> =
  defineEventHook<ConversationOpenedPayload>("session-orchestrator/conversation-opened");

/** Purely visual grouping metadata; never changes lineage or manageability. */
export interface ConversationTabGroupChangedPayload {
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly tabGroupParentId: string | null;
}

export const conversationTabGroupChanged: EventHookDescriptor<ConversationTabGroupChangedPayload> =
  defineEventHook<ConversationTabGroupChangedPayload>(
    "session-orchestrator/conversation-tab-group-changed",
  );

/** Payload for the conversationStatusChanged bus event. */
export interface ConversationStatusChangedPayload {
  readonly conversationId: string;
  readonly status: ConversationStatus;
  /**
   * The conversation's actual persisted workspace id (resolved from the
   * store, not the per-turn start option), so a frontend can sync the tab
   * in the correct workspace. Falls back to `"default"`.
   */
  readonly workspaceId: string;
}

/**
 * Fired when a conversation's lifecycle status changes (active/idle/closed).
 * Transport-ws subscribes and broadcasts a `conversation.statusChanged` WS
 * message to all connected frontend clients so tabs sync across devices.
 */
export const conversationStatusChanged: EventHookDescriptor<ConversationStatusChangedPayload> =
  defineEventHook<ConversationStatusChangedPayload>(
    "session-orchestrator/conversation-status-changed",
  );

/** Payload for the conversationCompacted bus event. */
export interface ConversationCompactedPayload {
  readonly conversationId: string;
  readonly newConversationId: string;
  readonly messagesSummarized: number;
  readonly messagesKept: number;
  /** Persisted history epoch read immediately after replacement. */
  readonly historyEpoch: number;
}

/**
 * Fired when a conversation's history has been compacted (old messages
 * summarized, recent messages retained). Transport-ws subscribes and
 * broadcasts a `conversation.compacted` WS message so the FE reloads history.
 */
export const conversationCompacted: EventHookDescriptor<ConversationCompactedPayload> =
  defineEventHook<ConversationCompactedPayload>("session-orchestrator/conversation-compacted");

/** Payload for the warmCompleted bus event. */
export interface WarmCompletedPayload {
  readonly conversationId: string;
  readonly usage: WarmResult;
}

/** Fired when a warm probe succeeds (both automatic and manual paths). */
export const warmCompleted: EventHookDescriptor<WarmCompletedPayload> =
  defineEventHook<WarmCompletedPayload>("session-orchestrator/warm-completed");
