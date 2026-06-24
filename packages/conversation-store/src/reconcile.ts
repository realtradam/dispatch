import type { ChatMessage, ToolCallChunk, ToolResultChunk } from "@dispatch/kernel";

export interface ReconcileReport {
	readonly repairedCount: number;
	readonly repairedToolCallIds: readonly string[];
	/** Number of `error` chunks stripped from assistant messages. */
	readonly strippedErrorChunks: number;
	/** Number of assistant messages dropped after stripping left them empty. */
	readonly droppedEmptyMessages: number;
}

export interface ReconcileResult {
	readonly messages: ChatMessage[];
	readonly report: ReconcileReport;
}

export function reconcileWithReport(messages: readonly ChatMessage[]): ReconcileResult {
	// Phase 1: strip `error` chunks from assistant messages. An error chunk is a
	// failed-generation marker, never valid provider content — removing it here
	// (on load, before any provider sees the messages) auto-repairs broken chats
	// with no DB surgery (append-only storage untouched).
	let strippedErrorChunks = 0;
	const stripped: ChatMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant" && msg.chunks.some((c) => c.type === "error")) {
			const filtered = msg.chunks.filter((chunk) => {
				if (chunk.type === "error") {
					strippedErrorChunks++;
					return false;
				}
				return true;
			});
			stripped.push({ role: msg.role, chunks: filtered });
		} else {
			stripped.push(msg);
		}
	}

	// Phase 2: drop assistant messages left with neither `text` nor `tool-call`
	// chunks after stripping (the now-empty error-only message). This is what
	// unblocks continuation: such a message serializes to nothing a provider
	// understands. Safe: it ends with no tool-call, so it is NEVER followed by a
	// `tool` message — no "tool-without-preceding-assistant-tool_calls" 400.
	let droppedEmptyMessages = 0;
	const pruned: ChatMessage[] = [];
	for (const msg of stripped) {
		if (msg.role === "assistant") {
			const hasContent = msg.chunks.some(
				(chunk) => chunk.type === "text" || chunk.type === "tool-call",
			);
			if (!hasContent) {
				droppedEmptyMessages++;
				continue;
			}
		}
		pruned.push(msg);
	}

	// Phase 3: orphaned-tool-call synthesis (unchanged) on what remains.
	const resolvedIds = new Set<string>();
	for (const msg of pruned) {
		for (const chunk of msg.chunks) {
			if (chunk.type === "tool-result") {
				resolvedIds.add(chunk.toolCallId);
			}
		}
	}

	const orphaned: ToolCallChunk[] = [];
	for (const msg of pruned) {
		if (msg.role !== "assistant") continue;
		for (const chunk of msg.chunks) {
			if (chunk.type === "tool-call" && !resolvedIds.has(chunk.toolCallId)) {
				orphaned.push(chunk);
			}
		}
	}

	const result: ChatMessage[] = [...pruned];

	for (const call of orphaned) {
		const base = {
			type: "tool-result" as const,
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			content: "interrupted: tool execution did not complete",
			isError: true,
		};
		const synthesized: ToolResultChunk =
			call.stepId !== undefined ? { ...base, stepId: call.stepId } : base;
		result.push({ role: "tool", chunks: [synthesized] });
	}

	return {
		messages: result,
		report: {
			repairedCount: orphaned.length,
			repairedToolCallIds: orphaned.map((c) => c.toolCallId),
			strippedErrorChunks,
			droppedEmptyMessages,
		},
	};
}

export function reconcile(messages: readonly ChatMessage[]): ChatMessage[] {
	return reconcileWithReport(messages).messages;
}
