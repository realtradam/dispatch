import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CoreMessage } from "ai";
import { streamText } from "ai";
import { buildBillingHeaderValue, SYSTEM_IDENTITY } from "../credentials/claude.js";
import { createProvider, prefixToolName, unprefixToolName } from "../llm/provider.js";
import { createToolRegistry } from "../tools/registry.js";
import { analyzeCommand } from "../tools/shell-analyze.js";
import type {
	AgentConfig,
	AgentEvent,
	AgentStatus,
	ChatMessage,
	QueueCallbacks,
	ToolCall,
	ToolResult,
} from "../types/index.js";

function toCoreMessages(messages: ChatMessage[], isAnthropic?: boolean): CoreMessage[] {
	const result: CoreMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			result.push({ role: "user", content: msg.content });
		} else if (msg.role === "assistant") {
			const parts: Array<
				| { type: "text"; text: string }
				| { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
			> = [{ type: "text", text: msg.content }];
			for (const tc of msg.toolCalls ?? []) {
				const toolName = isAnthropic ? prefixToolName(tc.name) : tc.name;
				parts.push({ type: "tool-call", toolCallId: tc.id, toolName, args: tc.arguments });
			}
			result.push({ role: "assistant", content: parts });
			for (const tr of msg.toolResults ?? []) {
				const toolName = isAnthropic ? prefixToolName(tr.toolName) : tr.toolName;
				result.push({
					role: "tool",
					content: [
						{ type: "tool-result", toolCallId: tr.toolCallId, toolName, result: tr.result },
					],
				});
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

const MAX_STEPS = 10;

export class Agent {
	status: AgentStatus = "idle";
	messages: ChatMessage[] = [];

	private config: AgentConfig;
	private queueCallbacks?: QueueCallbacks;

	constructor(config: AgentConfig, queueCallbacks?: QueueCallbacks) {
		this.config = config;
		this.queueCallbacks = queueCallbacks;
	}

	private async executeToolWithStreaming(
		tc: ToolCall,
		shellOutputQueue: Array<{ data: string; stream: "stdout" | "stderr" }>,
	): Promise<ToolResult> {
		const registry = createToolRegistry(this.config.tools);
		const tool = registry.getTool(tc.name);
		if (!tool) {
			return {
				toolCallId: tc.id,
				toolName: tc.name,
				result: `Unknown tool: ${tc.name}`,
				isError: true,
			};
		}

		// Permission check for shell commands — only prompt for external directory access.
		// Commands that stay within the working directory are auto-allowed.
		if (tc.name === "run_shell" && this.config.permissionChecker) {
			const command = typeof tc.arguments.command === "string" ? tc.arguments.command : "";
			const workingDirectory = this.config.workingDirectory;
			const analysis = await analyzeCommand(command, workingDirectory);
			const ruleset = this.config.ruleset ?? [];

			// Check for external directory access from shell command
			if (analysis.dirs.length > 0) {
				const dirRequest = {
					permission: "external_directory",
					patterns: analysis.dirs.map((d) => `${d}/*`),
					always: analysis.dirs.map((d) => `${d}/*`),
					description: `Shell command accesses external directory: ${analysis.dirs.join(", ")}`,
					metadata: { command, dirs: analysis.dirs },
				};
				try {
					const dirReply = await this.config.permissionChecker.ask(dirRequest, [ruleset]);
					if (dirReply === "reject") {
						return {
							toolCallId: tc.id,
							toolName: tc.name,
							result: `Permission denied: access to external directories rejected`,
							isError: true,
						};
					}
				} catch {
					return {
						toolCallId: tc.id,
						toolName: tc.name,
						result: `Permission denied: external directory access not allowed`,
						isError: true,
					};
				}
			}
		}

		// Permission check for file tools accessing paths outside workspace
		if (
			this.config.permissionChecker &&
			(tc.name === "read_file" || tc.name === "write_file" || tc.name === "list_files")
		) {
			const pathArg = typeof tc.arguments.path === "string" ? tc.arguments.path : ".";
			let resolvedPath: string;
			try {
				resolvedPath = realpathSync(resolve(this.config.workingDirectory, pathArg));
			} catch {
				// Path doesn't exist yet (e.g. write_file creating a new file) — fall back
				resolvedPath = resolve(this.config.workingDirectory, pathArg);
			}

			// Check if outside workspace
			const rel = relative(this.config.workingDirectory, resolvedPath);
			const isOutside =
				rel.startsWith("../") || rel.startsWith("..\\") || rel === ".." || isAbsolute(rel);

			if (isOutside) {
				const permissionType =
					tc.name === "read_file" ? "read" : tc.name === "write_file" ? "edit" : "list";

				const parentDir = dirname(resolvedPath);
				const request = {
					permission: "external_directory",
					patterns: [`${parentDir}/*`],
					always: [`${parentDir}/*`],
					description: `${permissionType} file outside workspace: ${resolvedPath}`,
					metadata: { filepath: resolvedPath, parentDir, operation: permissionType },
				};

				const ruleset = this.config.ruleset ?? [];
				try {
					const reply = await this.config.permissionChecker.ask(request, [ruleset]);
					if (reply === "reject") {
						return {
							toolCallId: tc.id,
							toolName: tc.name,
							result: `Permission denied: ${permissionType} access to ${resolvedPath} rejected`,
							isError: true,
						};
					}
				} catch {
					return {
						toolCallId: tc.id,
						toolName: tc.name,
						result: `Permission denied: ${permissionType} access to ${resolvedPath} not allowed`,
						isError: true,
					};
				}
			}
		}

		try {
			const execPromise = tool.execute(tc.arguments, {
				onOutput: (data: string, stream: "stdout" | "stderr") => {
					shellOutputQueue.push({ data, stream });
				},
				queueCallbacks: this.queueCallbacks,
			});

			const rawResult = await execPromise;
			const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
			return {
				toolCallId: tc.id,
				toolName: tc.name,
				result: resultStr,
				isError: resultStr.startsWith("Error:"),
			};
		} catch (err) {
			return {
				toolCallId: tc.id,
				toolName: tc.name,
				result: err instanceof Error ? err.message : String(err),
				isError: true,
			};
		}
	}

	async *run(
		userMessage: string,
		options?: { reasoningEffort?: "none" | "low" | "medium" | "high" | "max" },
	): AsyncGenerator<AgentEvent> {
		this.status = "running";
		yield { type: "status", status: "running" };

		this.messages.push({ role: "user", content: userMessage });

		const registry = createToolRegistry(this.config.tools);
		const isAnthropic = this.config.provider === "anthropic";
		const providerFactory = createProvider({
			apiKey: this.config.apiKey,
			baseURL: this.config.baseURL,
			provider: this.config.provider,
			claudeCredentials: this.config.claudeCredentials,
		});

		// For Anthropic provider, prefix tool names and build full system prompt
		const aiTools = registry.getAISDKTools();
		const tools = isAnthropic
			? Object.fromEntries(
					Object.entries(aiTools).map(([name, tool]) => [prefixToolName(name), tool]),
				)
			: aiTools;

		// Build system prompt
		let systemPrompt = this.config.systemPrompt;
		if (isAnthropic) {
			const billingHeader = buildBillingHeaderValue(this.messages);
			systemPrompt = `${billingHeader}\n${SYSTEM_IDENTITY}\n\n${systemPrompt}`;
		}

		try {
			// Track the final assistant message across all steps
			let finalText = "";
			const allToolCalls: ToolCall[] = [];
			const allToolResults: ToolResult[] = [];

			// We build up a local message list for multi-turn within one run() call
			// that includes tool results fed back to the LLM
			const stepMessages: ChatMessage[] = [...this.messages];

			for (let step = 0; step < MAX_STEPS; step++) {
				const effort = options?.reasoningEffort ?? this.config.reasoningEffort ?? "max";

				// Build stream text options
				const streamOptions: Parameters<typeof streamText>[0] = {
					model: providerFactory(this.config.model),
					system: systemPrompt,
					messages: toCoreMessages(stepMessages, isAnthropic),
					tools,
				};

				if (isAnthropic && effort !== "none") {
					const budgetTokens =
						effort === "max"
							? 16000
							: effort === "high"
								? 10000
								: effort === "medium"
									? 5000
									: effort === "low"
										? 2000
										: 0;
					streamOptions.providerOptions = {
						anthropic: { thinking: { type: "enabled" as const, budgetTokens } },
					};
					streamOptions.maxTokens = budgetTokens + 8000;
				} else if (!isAnthropic && effort !== "none") {
					streamOptions.providerOptions = { openaiCompatible: { reasoningEffort: effort } };
				}

				const result = streamText(streamOptions);

				let stepText = "";
				const stepToolCalls: ToolCall[] = [];

				try {
					for await (const event of result.fullStream) {
						if (event.type === "text-delta") {
							stepText += event.textDelta;
							finalText += event.textDelta;
							yield { type: "text-delta", delta: event.textDelta };
						} else if (event.type === "reasoning") {
							yield { type: "reasoning-delta", delta: event.textDelta };
						} else if (event.type === "tool-call") {
							const rawName = event.toolName;
							const toolName = isAnthropic ? unprefixToolName(rawName) : rawName;
							const toolCall: ToolCall = {
								id: event.toolCallId,
								name: toolName,
								arguments: event.args as Record<string, unknown>,
							};
							stepToolCalls.push(toolCall);
							allToolCalls.push(toolCall);
							yield { type: "tool-call", toolCall };
						} else if (event.type === "error") {
							const errorMsg = formatError(event.error, this.config);
							yield { type: "error", error: errorMsg };
							this.status = "error";
							yield { type: "status", status: "error" };
							return;
						}
					}
				} catch (streamErr) {
					const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
					const unavailMatch = errMsg.match(/tried to call unavailable tool '([^']+)'/i);
					if (!unavailMatch) throw streamErr;

					// Model tried to call an unavailable tool.
					// Add a synthetic tool call + error result for the bad tool.
					const badToolName = unavailMatch[1] as string;
					const fakeId = `unavail_${crypto.randomUUID().slice(0, 8)}`;
					const availableTools = Object.keys(aiTools).join(", ");
					const errorResult = `Tool "${badToolName}" is not available. Available tools: ${availableTools}. Please use only available tools.`;

					const badToolCall: ToolCall = {
						id: fakeId,
						name: badToolName,
						arguments: {},
					};
					stepToolCalls.push(badToolCall);
					allToolCalls.push(badToolCall);
					yield { type: "tool-call", toolCall: badToolCall };

					const badToolResult: ToolResult = {
						toolCallId: fakeId,
						toolName: badToolName,
						result: errorResult,
						isError: true,
					};
					allToolResults.push(badToolResult);
					yield { type: "tool-result", toolResult: badToolResult };
				}

				// No tool calls means the agent is done
				if (stepToolCalls.length === 0) {
					// Add the final assistant message to step messages (for history)
					stepMessages.push({
						role: "assistant",
						content: stepText,
					});
					break;
				}

				// Add assistant message with tool calls to step messages
				stepMessages.push({
					role: "assistant",
					content: stepText,
					toolCalls: stepToolCalls,
				});

				// Execute tool calls manually
				const stepToolResults: ToolResult[] = [];
				// Track tool calls that already have results (e.g. synthetic unavailable-tool errors)
				const alreadyResolved = new Set(allToolResults.map((r) => r.toolCallId));

				for (const tc of stepToolCalls) {
					// Skip execution for tool calls that already have synthetic results
					if (alreadyResolved.has(tc.id)) {
						const existing = allToolResults.find((r) => r.toolCallId === tc.id);
						if (existing) stepToolResults.push(existing);
						continue;
					}

					const shellOutputQueue: Array<{ data: string; stream: "stdout" | "stderr" }> = [];

					const execPromise = this.executeToolWithStreaming(tc, shellOutputQueue);

					// Poll for shell output while the tool is running, using Promise.race
					// so we can yield shell-output events as they arrive rather than buffering
					// them all until tool completion.
					let toolResult: ToolResult | undefined;
					while (toolResult === undefined) {
						if (shellOutputQueue.length > 0) {
							const item = shellOutputQueue.shift();
							if (item) yield { type: "shell-output", data: item.data, stream: item.stream };
							continue;
						}
						const raceResult = await Promise.race([
							execPromise.then((r) => ({ done: true as const, value: r })),
							new Promise<{ done: false }>((resolve) =>
								setImmediate(() => resolve({ done: false })),
							),
						]);
						if (raceResult.done) {
							toolResult = raceResult.value;
						}
					}

					// Drain any remaining shell output emitted before we read the result
					while (shellOutputQueue.length > 0) {
						const item = shellOutputQueue.shift();
						if (item) yield { type: "shell-output", data: item.data, stream: item.stream };
					}

					// Check for queued user messages and append them to the tool result
					let finalToolResult = toolResult;
					if (this.queueCallbacks) {
						const queuedMsgs = this.queueCallbacks.dequeueMessages();
						if (queuedMsgs.length > 0) {
							const userMessages = queuedMsgs.map((m) => m.message).join("\n---\n");
							finalToolResult = {
								...toolResult,
								result: `${toolResult.result}\n\n[USER INTERRUPT]\nThe user has sent you message(s) while you were working. You MUST address these before continuing with your current task:\n\n${userMessages}`,
							};
						}
					}

					stepToolResults.push(finalToolResult);
					allToolResults.push(finalToolResult);
					yield { type: "tool-result", toolResult: finalToolResult };
				}

				// Add tool results back to step messages so LLM can see them
				// We append them to the last assistant message's toolResults
				const lastMsg = stepMessages[stepMessages.length - 1];
				if (lastMsg) {
					lastMsg.toolResults = stepToolResults;
				}
			}

			// If we exhausted MAX_STEPS and there were pending tool calls, surface an error
			if (stepMessages.length > 0) {
				const lastMsg = stepMessages[stepMessages.length - 1];
				if (lastMsg?.toolCalls && lastMsg.toolCalls.length > 0 && !lastMsg.toolResults) {
					yield {
						type: "error",
						error: `Agent reached MAX_STEPS (${MAX_STEPS}) with unresolved tool calls`,
					};
				}
			}

			const assistantMessage: ChatMessage = {
				role: "assistant",
				content: finalText,
				toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
				toolResults: allToolResults.length > 0 ? allToolResults : undefined,
			};
			this.messages.push(assistantMessage);

			// Drain any remaining queued messages that arrived after the last tool call
			if (this.queueCallbacks) {
				const remaining = this.queueCallbacks.dequeueMessages();
				if (remaining.length > 0) {
					// These messages arrived too late to be injected into a tool result.
					// Append them as a user message to the conversation so they're not lost.
					const userMessages = remaining.map((m) => m.message).join("\n---\n");
					this.messages.push({
						role: "user",
						content: userMessages,
					});
				}
			}

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
