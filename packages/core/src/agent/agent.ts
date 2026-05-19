import type { CoreMessage } from "ai";
import { streamText } from "ai";
import { createProvider } from "../llm/provider.js";
import { createToolRegistry } from "../tools/registry.js";
import type {
	AgentConfig,
	AgentEvent,
	AgentStatus,
	ChatMessage,
	ToolCall,
	ToolResult,
} from "../types/index.js";

function toCoreMessages(messages: ChatMessage[]): CoreMessage[] {
	const result: CoreMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			result.push({ role: "user", content: msg.content });
		} else if (msg.role === "assistant") {
			const parts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }> = [{ type: "text", text: msg.content }];
			for (const tc of msg.toolCalls ?? []) {
				parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
			}
			result.push({ role: "assistant", content: parts });
			for (const tr of msg.toolResults ?? []) {
				result.push({ role: "tool", content: [{ type: "tool-result", toolCallId: tr.toolCallId, toolName: "", result: tr.result }] });
			}
		}
	}
	return result;
}

function formatError(err: unknown, config: AgentConfig): string {
	const context = `[model=${config.model}, baseURL=${config.baseURL}]`;

	if (err instanceof Error) {
		const cause = err.cause ? ` | cause: ${JSON.stringify(err.cause)}` : "";
		// AI SDK errors often have statusCode, responseBody, or url properties
		const extras: string[] = [];
		const errRecord = err as unknown as Record<string, unknown>;
		if ("statusCode" in errRecord) extras.push(`status=${errRecord.statusCode}`);
		if ("url" in errRecord) extras.push(`url=${errRecord.url}`);
		if ("responseBody" in errRecord) extras.push(`body=${JSON.stringify(errRecord.responseBody)}`);
		if ("responseHeaders" in errRecord)
			extras.push(`headers=${JSON.stringify(errRecord.responseHeaders)}`);

		const detail = extras.length > 0 ? ` (${extras.join(", ")})` : "";
		return `${err.message}${detail}${cause} ${context}`;
	}

	return `${String(err)} ${context}`;
}

export class Agent {
	status: AgentStatus = "idle";
	messages: ChatMessage[] = [];

	private config: AgentConfig;

	constructor(config: AgentConfig) {
		this.config = config;
	}

	async *run(userMessage: string): AsyncGenerator<AgentEvent> {
		this.status = "running";
		yield { type: "status", status: "running" };

		this.messages.push({ role: "user", content: userMessage });

		const registry = createToolRegistry(this.config.tools);
		const providerFactory = createProvider({
			apiKey: this.config.apiKey,
			baseURL: this.config.baseURL,
		});

		try {
			const result = streamText({
				model: providerFactory(this.config.model),
				system: this.config.systemPrompt,
				messages: toCoreMessages(this.messages),
				tools: registry.getAISDKTools(),
				maxSteps: 10,
			});

			let fullText = "";
			const toolCalls: ToolCall[] = [];
			const toolResults: ToolResult[] = [];

			for await (const event of result.fullStream) {
				if (event.type === "text-delta") {
					fullText += event.textDelta;
					yield { type: "text-delta", delta: event.textDelta };
				} else if (event.type === "tool-call") {
					const toolCall: ToolCall = {
						id: event.toolCallId,
						name: event.toolName,
						arguments: event.args as Record<string, unknown>,
					};
					toolCalls.push(toolCall);
					yield { type: "tool-call", toolCall };
				} else if (event.type === "error") {
					const errorMsg = formatError(event.error, this.config);
					yield { type: "error", error: errorMsg };
					this.status = "error";
					yield { type: "status", status: "error" };
					return;
				}
			}

			// Tool results are available from completed steps after streaming.
			// The generic TOOLS type resolves to never[] at compile time, so
			// we cast through unknown to access the runtime shape.
			const steps = await result.steps;
			for (const step of steps) {
				const stepToolResults = step.toolResults as unknown as Array<{
					toolCallId: string;
					result: unknown;
					isError?: boolean;
				}>;
				for (const tr of stepToolResults) {
					const toolResult: ToolResult = {
						toolCallId: tr.toolCallId,
						result: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
						isError: tr.isError ?? false,
					};
					toolResults.push(toolResult);
					yield { type: "tool-result", toolResult };
				}
			}

			const assistantMessage: ChatMessage = {
				role: "assistant",
				content: fullText,
				toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
				toolResults: toolResults.length > 0 ? toolResults : undefined,
			};
			this.messages.push(assistantMessage);
			yield { type: "done", message: assistantMessage };
		} catch (err) {
			const errorMsg = formatError(err, this.config);
			yield { type: "error", error: errorMsg };
			this.status = "error";
			yield { type: "status", status: "error" };
			return;
		}

		this.status = "idle";
		yield { type: "status", status: "idle" };
	}
}
