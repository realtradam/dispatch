import type { ProviderEvent } from "@dispatch/kernel";

interface ToolCallAccumulator {
	id: string;
	name: string;
	arguments: string;
}

interface SSEChunkDelta {
	content?: string;
	reasoning_content?: string;
	tool_calls?: Array<{
		index: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

interface SSEChunkChoice {
	delta: SSEChunkDelta;
	finish_reason?: string | null;
	index: number;
}

interface SSEChunk {
	id?: string;
	choices?: SSEChunkChoice[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cache_read_tokens?: number;
		cache_write_tokens?: number;
	};
}

export function parseSSELines(lines: readonly string[]): ProviderEvent[] {
	const events: ProviderEvent[] = [];
	const toolCalls = new Map<number, ToolCallAccumulator>();

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;

		const data = trimmed.slice(5).trim();
		if (data === "[DONE]") break;

		let chunk: SSEChunk;
		try {
			chunk = JSON.parse(data) as SSEChunk;
		} catch {
			events.push({ type: "error", message: `Invalid JSON in SSE data: ${data}` });
			continue;
		}

		if (chunk.choices) {
			for (const choice of chunk.choices) {
				const delta = choice.delta;

				if (delta.content) {
					events.push({ type: "text-delta", delta: delta.content });
				}

				if (delta.reasoning_content) {
					events.push({ type: "reasoning-delta", delta: delta.reasoning_content });
				}

				if (delta.tool_calls) {
					for (const tc of delta.tool_calls) {
						const existing = toolCalls.get(tc.index);
						if (existing) {
							if (tc.function?.arguments) {
								existing.arguments += tc.function.arguments;
							}
						} else {
							toolCalls.set(tc.index, {
								id: tc.id ?? "",
								name: tc.function?.name ?? "",
								arguments: tc.function?.arguments ?? "",
							});
						}
					}
				}

				if (choice.finish_reason) {
					const sortedIndices = [...toolCalls.keys()].sort((a, b) => a - b);
					for (const idx of sortedIndices) {
						const acc = toolCalls.get(idx);
						if (!acc) continue;
						let input: unknown;
						try {
							input = JSON.parse(acc.arguments);
						} catch {
							input = acc.arguments;
						}
						events.push({
							type: "tool-call",
							toolCallId: acc.id,
							toolName: acc.name,
							input,
						});
					}
					events.push({ type: "finish", reason: choice.finish_reason });
				}
			}
		}

		if (chunk.usage) {
			events.push({
				type: "usage",
				usage: {
					inputTokens: chunk.usage.prompt_tokens ?? 0,
					outputTokens: chunk.usage.completion_tokens ?? 0,
					...(chunk.usage.cache_read_tokens !== undefined
						? { cacheReadTokens: chunk.usage.cache_read_tokens }
						: {}),
					...(chunk.usage.cache_write_tokens !== undefined
						? { cacheWriteTokens: chunk.usage.cache_write_tokens }
						: {}),
				},
			});
		}
	}

	return events;
}
