import type { ChatMessage, ToolCallChunk, ToolResultChunk } from "@dispatch/kernel";

export interface ReconcileReport {
	readonly repairedCount: number;
	readonly repairedToolCallIds: readonly string[];
}

export interface ReconcileResult {
	readonly messages: ChatMessage[];
	readonly report: ReconcileReport;
}

export function reconcileWithReport(messages: readonly ChatMessage[]): ReconcileResult {
	const resolvedIds = new Set<string>();
	for (const msg of messages) {
		for (const chunk of msg.chunks) {
			if (chunk.type === "tool-result") {
				resolvedIds.add(chunk.toolCallId);
			}
		}
	}

	const orphaned: ToolCallChunk[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const chunk of msg.chunks) {
			if (chunk.type === "tool-call" && !resolvedIds.has(chunk.toolCallId)) {
				orphaned.push(chunk);
			}
		}
	}

	const result: ChatMessage[] = [...messages];

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
		},
	};
}

export function reconcile(messages: readonly ChatMessage[]): ChatMessage[] {
	return reconcileWithReport(messages).messages;
}
