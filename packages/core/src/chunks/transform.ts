// Pure, dependency-free transforms between the render-shaped `Chunk[]` /
// `ChatMessage` model and the flat append-only `ChunkRow` log. Kept free of any
// DB (`bun:sqlite`) import so BOTH the backend persistence layer
// (`db/chunks.ts`) and the browser frontend store can share the exact same
// explode/group logic.

import type {
	Chunk,
	ChunkRow,
	ChunkRowDraft,
	ErrorData,
	MessageRole,
	SystemData,
	TextData,
	ThinkingData,
	ToolBatchChunk,
	ToolCallData,
	ToolResultData,
} from "../types/index.js";

/**
 * A DERIVED message — a grouping of contiguous chunk rows reconstructed for the
 * agent's in-memory history and for the frontend's render bubbles. NOT a stored
 * shape: the source of truth is the flat chunk log.
 */
export interface MessageRow {
	id: string;
	tabId: string;
	seq: number;
	/** turn_id of the chunk rows this message was grouped from. */
	turnId: string;
	role: MessageRole;
	chunks: Chunk[];
	createdAt: number;
}

// ─── Explode: in-memory turn → flat chunk-row drafts ─────────────
//
// A turn's render-shaped `Chunk[]` is flattened into append-only rows.
// `tool-batch` chunks are split into SEPARATE `tool_call` (role=assistant) and
// `tool_result` (role=tool) rows linked by `callId`, mapping 1:1 to the
// Anthropic wire format. `step` increments after each tool-batch: every LLM
// round-trip emits text/thinking then (optionally) one tool-batch, so a
// tool-batch boundary is exactly a step boundary.

/** Explode a single user message's text into one row draft. */
export function explodeUserText(turnId: string, text: string): ChunkRowDraft[] {
	return [{ turnId, step: 0, role: "user", type: "text", data: { text } }];
}

/** Explode an assistant turn's accumulated chunks into ordered row drafts. */
export function explodeTurn(turnId: string, chunks: Chunk[]): ChunkRowDraft[] {
	const drafts: ChunkRowDraft[] = [];
	let step = 0;
	for (const chunk of chunks) {
		switch (chunk.type) {
			case "text":
				drafts.push({ turnId, step, role: "assistant", type: "text", data: { text: chunk.text } });
				break;
			case "thinking":
				drafts.push({
					turnId,
					step,
					role: "assistant",
					type: "thinking",
					data: {
						text: chunk.text,
						...(chunk.metadata !== undefined ? { metadata: chunk.metadata } : {}),
					},
				});
				break;
			case "tool-batch": {
				for (const call of chunk.calls) {
					drafts.push({
						turnId,
						step,
						role: "assistant",
						type: "tool_call",
						data: { callId: call.id, name: call.name, arguments: call.arguments },
					});
				}
				for (const call of chunk.calls) {
					if (call.result === undefined) continue;
					drafts.push({
						turnId,
						step,
						role: "tool",
						type: "tool_result",
						data: {
							callId: call.id,
							name: call.name,
							result: call.result,
							isError: call.isError ?? false,
							...(call.shellOutput !== undefined ? { shellOutput: call.shellOutput } : {}),
						},
					});
				}
				// A tool-batch ends the current LLM step; subsequent chunks belong
				// to the next round-trip.
				step++;
				break;
			}
			case "error":
				drafts.push({
					turnId,
					step,
					role: "assistant",
					type: "error",
					data: {
						message: chunk.message,
						...(chunk.statusCode !== undefined ? { statusCode: chunk.statusCode } : {}),
					},
				});
				break;
			case "system":
				drafts.push({
					turnId,
					step,
					role: "system",
					type: "system",
					data: { kind: chunk.kind, text: chunk.text },
				});
				break;
		}
	}
	return drafts;
}

// ─── Group: flat chunk rows → derived render messages ────────────
//
// The inverse of explode (best-effort over an arbitrary window, so it tolerates
// orphan tool-results whose tool-call was paged out). `tool_result` rows
// (role=tool) merge back into the preceding assistant message's per-step
// `tool-batch` chunk by `callId` rather than forming their own message.

export function groupRowsToMessages(rows: ChunkRow[]): MessageRow[] {
	const messages: MessageRow[] = [];

	let current: { msg: MessageRow; batches: Map<number, ToolBatchChunk> } | null = null;
	const flush = () => {
		if (current) {
			messages.push(current.msg);
			current = null;
		}
	};
	const ensureAssistant = (row: ChunkRow) => {
		if (!current) {
			current = {
				msg: {
					id: row.id,
					tabId: row.tabId,
					seq: row.seq,
					turnId: row.turnId,
					role: "assistant",
					chunks: [],
					createdAt: row.createdAt,
				},
				batches: new Map(),
			};
		}
		return current;
	};
	const ensureBatch = (step: number): ToolBatchChunk => {
		const c = current;
		if (!c) throw new Error("ensureBatch called without an assistant message");
		let batch = c.batches.get(step);
		if (!batch) {
			batch = { type: "tool-batch", calls: [] };
			c.batches.set(step, batch);
			c.msg.chunks.push(batch);
		}
		return batch;
	};

	for (const row of rows) {
		if (row.role === "user") {
			flush();
			const d = row.data as TextData;
			messages.push({
				id: row.id,
				tabId: row.tabId,
				seq: row.seq,
				turnId: row.turnId,
				role: "user",
				chunks: [{ type: "text", text: d.text }],
				createdAt: row.createdAt,
			});
			continue;
		}
		if (row.role === "system") {
			// Coalesce consecutive system rows into one system message (multiple
			// system chunks), matching the old applySystemEvent behaviour.
			const prev = messages[messages.length - 1];
			const d = row.data as SystemData;
			if (current === null && prev && prev.role === "system") {
				prev.chunks.push({ type: "system", kind: d.kind, text: d.text });
				continue;
			}
			flush();
			messages.push({
				id: row.id,
				tabId: row.tabId,
				seq: row.seq,
				turnId: row.turnId,
				role: "system",
				chunks: [{ type: "system", kind: d.kind, text: d.text }],
				createdAt: row.createdAt,
			});
			continue;
		}

		// Usage rows are an invisible side channel (persisted for the backend
		// aggregate only). They're already query-excluded from getChunksForTab,
		// so this is defensive insurance: never let one leak into render grouping.
		if (row.type === "usage") continue;

		// assistant / tool rows → part of the current assistant message
		const c = ensureAssistant(row);
		switch (row.type) {
			case "text":
				c.msg.chunks.push({ type: "text", text: (row.data as TextData).text });
				break;
			case "thinking": {
				const d = row.data as ThinkingData;
				c.msg.chunks.push({
					type: "thinking",
					text: d.text,
					...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
				});
				break;
			}
			case "error": {
				const d = row.data as ErrorData;
				c.msg.chunks.push({
					type: "error",
					message: d.message,
					...(d.statusCode !== undefined ? { statusCode: d.statusCode } : {}),
				});
				break;
			}
			case "tool_call": {
				const d = row.data as ToolCallData;
				ensureBatch(row.step).calls.push({ id: d.callId, name: d.name, arguments: d.arguments });
				break;
			}
			case "tool_result": {
				const d = row.data as ToolResultData;
				const batch = ensureBatch(row.step);
				const entry = batch.calls.find((e) => e.id === d.callId);
				if (entry) {
					entry.result = d.result;
					entry.isError = d.isError;
					if (d.shellOutput !== undefined) entry.shellOutput = d.shellOutput;
				} else {
					// Orphan result (its tool_call was paged out of this window).
					batch.calls.push({
						id: d.callId,
						name: d.name,
						arguments: {},
						result: d.result,
						isError: d.isError,
						...(d.shellOutput !== undefined ? { shellOutput: d.shellOutput } : {}),
					});
				}
				break;
			}
		}
	}
	flush();
	return messages;
}
