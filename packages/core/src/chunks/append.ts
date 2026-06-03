/**
 * Chunk-builder helper.
 *
 * `appendEventToChunks` is the single source of truth for how a stream of
 * `AgentEvent`s collapses into an ordered `Chunk[]` on a message. Both the
 * backend (agent + agent-manager) and the frontend store call this helper
 * so the wire format stays in lockstep across the boundary.
 *
 * Open/close rules — see notes/plan-chunk-refactor.md for the full table.
 *
 *  | Chunk         | Opens on                                                        | Coalesces                                                  |
 *  |---------------|-----------------------------------------------------------------|------------------------------------------------------------|
 *  | `text`        | first `text-delta` after a non-text chunk                       | consecutive `text-delta` events append to `.text`          |
 *  | `thinking`    | first `reasoning-delta` after a non-thinking chunk              | consecutive `reasoning-delta` events append to `.text`     |
 *  |               | OR after the last thinking chunk was sealed by `reasoning-end`  | (only into the most recent UNSEALED thinking chunk)        |
 *  | `tool-batch`  | first `tool-call` after a non-tool-batch chunk                  | consecutive `tool-call` events push a new entry to `.calls`|
 *  | `error`       | every `error` event                                             | NEVER (always single-event)                                |
 *  | `system`      | every `notice`/`model-changed`/`config-reload`/...              | NEVER (two consecutive system events → two chunks)         |
 *
 * Side-effect events (no new chunk):
 *  - `tool-result`   → finds the call by `id` across all `tool-batch`
 *                       chunks (most-recent first) and updates its
 *                       `result` / `isError`.
 *  - `shell-output`  → appends to the most recent entry of the most
 *                       recent `tool-batch` chunk.
 *  - `reasoning-end` → attaches `metadata` (the AI SDK v6
 *                       `providerMetadata` blob) to the most recent
 *                       UNSEALED `thinking` chunk. The metadata is also
 *                       the "sealed" marker — subsequent
 *                       `reasoning-delta`s will open a new chunk rather
 *                       than extending this one. Anthropic's signature
 *                       lives inside this blob; round-tripping it on the
 *                       next turn is mandatory for Anthropic to accept
 *                       the conversation. Orphan `reasoning-end` events
 *                       (no unsealed thinking chunk) are dropped.
 *
 * Ignored events:
 *  - `status`, `turn-start`, `turn-sealed`, `done`, `usage`,
 *    `task-list-update`, `tab-created`, `message-queued`, `message-consumed`,
 *    `message-cancelled` — these are control / lifecycle events, not message
 *    content.
 */

import type {
	AgentEvent,
	ChatMessage,
	Chunk,
	MessageRole,
	SystemChunk,
	SystemChunkKind,
	ToolBatchChunk,
} from "../types/index.js";

/**
 * Mutates `chunks` in place based on `event`.
 *
 * Returns void; the array is the output channel.
 */
export function appendEventToChunks(chunks: Chunk[], event: AgentEvent): void {
	switch (event.type) {
		case "text-delta": {
			// Open or extend the current text chunk.
			const last = chunks[chunks.length - 1];
			if (last && last.type === "text") {
				last.text += event.delta;
			} else {
				chunks.push({ type: "text", text: event.delta });
			}
			return;
		}

		case "reasoning-delta": {
			// Open a new thinking chunk if the last chunk is not a thinking
			// chunk OR if it's already sealed by metadata. Anthropic emits
			// each thinking content block with its own metadata; a fresh
			// reasoning-delta after a sealed thinking chunk is the start of
			// a new block, not a continuation — extending the sealed chunk
			// would corrupt the metadata/text mapping.
			const last = chunks[chunks.length - 1];
			if (last && last.type === "thinking" && last.metadata === undefined) {
				last.text += event.delta;
			} else {
				chunks.push({ type: "thinking", text: event.delta });
			}
			return;
		}

		case "reasoning-end": {
			// Attach `providerMetadata` to the most recent unsealed
			// thinking chunk. Anthropic's signature lives inside this
			// blob; without it on the next request, Anthropic rejects the
			// thinking block. The walk-back is a defensive backstop —
			// Anthropic's SSE delivers a content block's deltas strictly
			// in order and `appendEventToChunks` runs synchronously per
			// event, so the most recent thinking chunk is normally the
			// last chunk in the array.
			if (event.metadata === undefined) return;
			for (let i = chunks.length - 1; i >= 0; i--) {
				const c = chunks[i];
				if (!c || c.type !== "thinking") continue;
				if (c.metadata !== undefined) {
					// Already sealed; the orphan metadata has no home.
					return;
				}
				c.metadata = event.metadata;
				return;
			}
			// No thinking chunk found at all — drop silently.
			return;
		}

		case "tool-call": {
			// Open or extend the current tool-batch chunk.
			const last = chunks[chunks.length - 1];
			const entry = {
				id: event.toolCall.id,
				name: event.toolCall.name,
				arguments: event.toolCall.arguments,
			};
			if (last && last.type === "tool-batch") {
				last.calls.push(entry);
			} else {
				chunks.push({ type: "tool-batch", calls: [entry] });
			}
			return;
		}

		case "tool-result": {
			// Find the matching call (by id) across all tool-batch chunks,
			// most-recent first. Tool results can arrive after subsequent
			// text-deltas, so we cannot rely on the *last* chunk being the
			// tool-batch — we have to search.
			for (let i = chunks.length - 1; i >= 0; i--) {
				const c = chunks[i];
				if (!c || c.type !== "tool-batch") continue;
				const call = c.calls.find((e) => e.id === event.toolResult.toolCallId);
				if (call) {
					call.result = event.toolResult.result;
					call.isError = event.toolResult.isError;
					return;
				}
			}
			// Orphan result with no matching call — drop silently.
			return;
		}

		case "shell-output": {
			// Append to the most recent entry of the most recent tool-batch.
			// Walk back through chunks to find the latest tool-batch; if there
			// are intervening text/thinking/etc chunks (which can happen if
			// the model streams text while a shell tool is still running),
			// we still want the most recent tool-batch.
			for (let i = chunks.length - 1; i >= 0; i--) {
				const c = chunks[i];
				if (!c || c.type !== "tool-batch") continue;
				const entry = c.calls[c.calls.length - 1];
				if (!entry) return;
				const prev = entry.shellOutput ?? { stdout: "", stderr: "" };
				entry.shellOutput = {
					stdout: prev.stdout + (event.stream === "stdout" ? event.data : ""),
					stderr: prev.stderr + (event.stream === "stderr" ? event.data : ""),
				};
				return;
			}
			// Orphan shell-output with no tool-batch in scope — drop silently.
			return;
		}

		case "error": {
			// Always a fresh single-event chunk — no coalescing.
			chunks.push({
				type: "error",
				message: event.error,
				...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
			});
			return;
		}

		case "notice": {
			chunks.push({ type: "system", kind: "notice", text: event.message });
			return;
		}

		case "model-changed": {
			chunks.push({
				type: "system",
				kind: "model-changed",
				text: `Switched to ${event.modelId} (${event.keyId})`,
			});
			return;
		}

		case "config-reload": {
			chunks.push({
				type: "system",
				kind: "config-reload",
				text: "Configuration reloaded",
			});
			return;
		}

		// Lifecycle / control events — no chunk emitted.
		case "status":
		case "turn-start":
		case "turn-sealed":
		case "done":
		case "usage":
		case "task-list-update":
		case "tab-created":
		case "message-queued":
		case "message-consumed":
		case "message-cancelled":
		case "compaction-started":
		case "compaction-complete":
		case "compaction-error":
			return;

		default: {
			// Exhaustiveness check — if a new event variant is added to
			// AgentEvent, TypeScript will complain here.
			const _exhaustive: never = event;
			void _exhaustive;
			return;
		}
	}
}

// ─── System event routing across messages ────────────────────────

/**
 * Minimal shape needed by `applySystemEvent`.
 *
 * The caller (agent-manager / persistence layer) typically tracks message
 * id alongside the wire-format `ChatMessage`. This generic constraint
 * lets us keep core `ChatMessage` clean while still letting downstream
 * pass anything with an `id`.
 */
export interface IdentifiedMessage {
	id: string;
	role: MessageRole;
	chunks: Chunk[];
}

/**
 * Describes the system event in caller-controlled terms. We let the caller
 * decide both the `kind` (so the same helper can record cancellations,
 * notices, model swaps, etc.) and the `text` (so the caller controls
 * formatting / localization).
 */
export interface SystemEventLike {
	kind: SystemChunkKind;
	text: string;
}

/**
 * Routes a system event to the right message when *no assistant turn is
 * in flight*. (When a turn IS in flight, the caller should instead use
 * `appendEventToChunks` against the in-flight message's chunks directly.)
 *
 * Routing rules (from notes/plan-chunk-refactor.md):
 *
 *  1. Most recent message is `role: "system"` → append a `system` chunk
 *     to it. (Note: a second consecutive system event creates a second
 *     system chunk inside the same system message — chunks themselves
 *     never coalesce.)
 *  2. Otherwise → create a fresh `role: "system"` message containing one
 *     `system` chunk and push it.
 *
 * Returns the `messageId` that was used (either the existing system
 * message's id or the newly-created one) so the caller can persist /
 * emit a diff to subscribers.
 *
 * `idFactory` defaults to `crypto.randomUUID()`; tests inject a
 * deterministic factory.
 */
export function applySystemEvent<M extends IdentifiedMessage>(
	messages: M[],
	event: SystemEventLike,
	idFactory: () => string = defaultIdFactory,
): { messageId: string } {
	const chunk: SystemChunk = { type: "system", kind: event.kind, text: event.text };

	const last = messages[messages.length - 1];
	if (last && last.role === "system") {
		last.chunks.push(chunk);
		return { messageId: last.id };
	}

	const id = idFactory();
	// We can't fabricate the full `M` shape without knowing its extra
	// fields, but `IdentifiedMessage` is the minimum we need to push.
	// Callers that extend the shape with extra fields are responsible for
	// initializing them via post-hoc patching, or by passing in their own
	// message-creation logic. In practice callers either:
	//  (a) use `ChatMessage` itself (no extra fields beyond IdentifiedMessage), or
	//  (b) construct messages and look them up by id after this call returns.
	const newMessage = { id, role: "system" as const, chunks: [chunk] } as unknown as M;
	messages.push(newMessage);
	return { messageId: id };
}

function defaultIdFactory(): string {
	// In Node 19+ / modern browsers, `crypto.randomUUID` is available globally.
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// Fallback: pseudo-random; not cryptographically secure, but adequate for
	// in-memory message identifiers when randomUUID is unavailable.
	return `sysmsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Re-exports for convenience ──────────────────────────────────

export type { ChatMessage, Chunk, SystemChunk, SystemChunkKind, ToolBatchChunk };
