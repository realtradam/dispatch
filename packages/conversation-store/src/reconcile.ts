import type { ChatMessage, ToolCallChunk, ToolResultChunk } from "@dispatch/kernel";

export function reconcile(messages: readonly ChatMessage[]): ChatMessage[] {
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

	return result;
}
