import type {
	ChatMessage,
	ProviderEvent,
	ProviderStreamOptions,
	ToolContract,
} from "@dispatch/kernel";
import { convertMessages, type OpenAIMessage } from "./convert-messages.js";
import { convertTools, type OpenAITool } from "./convert-tools.js";

export interface StreamConfig {
	readonly baseURL: string;
	readonly apiKey: string;
	readonly model: string;
}

export async function* streamChat(
	config: StreamConfig,
	messages: readonly ChatMessage[],
	tools: readonly ToolContract[],
	opts?: ProviderStreamOptions,
): AsyncIterable<ProviderEvent> {
	const openaiMessages = convertMessages(messages);
	const openaiTools = convertTools(tools);

	const systemPrompt = opts?.systemPrompt;
	const finalMessages: OpenAIMessage[] = systemPrompt
		? [{ role: "system", content: systemPrompt }, ...openaiMessages]
		: openaiMessages;

	const body: Record<string, unknown> = {
		model: opts?.model ?? config.model,
		messages: finalMessages,
		stream: true,
	};

	if (openaiTools.length > 0) {
		body.tools = openaiTools satisfies OpenAITool[];
	}
	if (opts?.temperature !== undefined) {
		body.temperature = opts.temperature;
	}
	if (opts?.maxTokens !== undefined) {
		body.max_tokens = opts.maxTokens;
	}

	let response: Response;
	try {
		response = await fetch(`${config.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		yield {
			type: "error",
			message: err instanceof Error ? err.message : String(err),
			retryable: true,
		};
		return;
	}

	if (!response.ok) {
		const text = await response.text().catch(() => "unknown");
		yield {
			type: "error",
			message: `HTTP ${response.status}: ${text}`,
			code: String(response.status),
			retryable: response.status >= 500 || response.status === 429,
		};
		return;
	}

	if (!response.body) {
		yield { type: "error", message: "Response body is null" };
		return;
	}

	yield* readSSEStream(response.body);
}

async function* readSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<ProviderEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;

				const data = trimmed.slice(5).trim();
				if (data === "[DONE]") return;

				let chunk: Record<string, unknown>;
				try {
					chunk = JSON.parse(data);
				} catch {
					yield { type: "error", message: `Invalid JSON in SSE data: ${data}` };
					continue;
				}

				const choices = chunk.choices as
					| Array<{
							delta: Record<string, unknown>;
							finish_reason?: string | null;
					  }>
					| undefined;

				if (choices) {
					for (const choice of choices) {
						const delta = choice.delta;

						if (typeof delta.content === "string" && delta.content) {
							yield { type: "text-delta", delta: delta.content };
						}

						if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
							yield { type: "reasoning-delta", delta: delta.reasoning_content };
						}

						const tcs = delta.tool_calls as
							| Array<{
									index: number;
									id?: string;
									function?: { name?: string; arguments?: string };
							  }>
							| undefined;

						if (tcs) {
							for (const tc of tcs) {
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
								yield {
									type: "tool-call",
									toolCallId: acc.id,
									toolName: acc.name,
									input,
								};
							}
							yield { type: "finish", reason: choice.finish_reason };
						}
					}
				}

				const usage = chunk.usage as
					| {
							prompt_tokens?: number;
							completion_tokens?: number;
					  }
					| undefined;

				if (usage) {
					yield {
						type: "usage",
						usage: {
							inputTokens: usage.prompt_tokens ?? 0,
							outputTokens: usage.completion_tokens ?? 0,
						},
					};
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
