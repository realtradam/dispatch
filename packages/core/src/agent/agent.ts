import { dirname } from "node:path";
import type { CoreMessage, CoreSystemMessage } from "ai";
import { streamText } from "ai";
import { appendEventToChunks } from "../chunks/append.js";
import { buildBillingHeaderValue, SYSTEM_IDENTITY } from "../credentials/claude.js";
import { createProvider, prefixToolName, unprefixToolName } from "../llm/provider.js";
import { canonicalize } from "../tools/path-utils.js";
import { createToolRegistry } from "../tools/registry.js";
import { analyzeCommand } from "../tools/shell-analyze.js";
import { applyTruncation, SPILL_ROOT } from "../tools/truncate.js";
import type {
	AgentConfig,
	AgentEvent,
	AgentStatus,
	ChatMessage,
	Chunk,
	QueueCallbacks,
	ToolCall,
	ToolResult,
} from "../types/index.js";

/**
 * Rebuild AI SDK `CoreMessage[]` from our internal `ChatMessage[]`.
 *
 * Strip rules (see plan-chunk-refactor.md):
 *  - `role: "system"` messages are skipped wholesale (they're display-only
 *    standalone-system bubbles that exist outside any model turn).
 *  - `error` chunks are skipped — the turn ended; the LLM doesn't need them.
 *  - `system` chunks are skipped — display-only notices.
 *  - `text` chunks → `{ type: "text", text }` parts.
 *  - `thinking` chunks → `{ type: "reasoning", text }` parts (handles
 *    Claude's `interleaved-thinking-2025-05-14` round-trip).
 *  - `tool-batch` chunks → one `{ type: "tool-call" }` part per entry
 *    inside the current assistant message, followed by a separate
 *    `{ role: "tool", content: [{ type: "tool-result", ... }] }` message
 *    for every entry that has a result. This mirrors what the AI SDK
 *    expects on the wire.
 *
 * Mixed-resolution tool batches (some entries with `result`, some without):
 * we emit tool-results only for the entries that have them. In practice
 * the agent resolves every tool call in a step before looping back to the
 * LLM, so this case only arises mid-step (where the message hasn't been
 * round-tripped to the LLM yet) and is benign.
 */
function toCoreMessages(messages: ChatMessage[], useToolPrefix?: boolean): CoreMessage[] {
	const result: CoreMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "system") continue;

		if (msg.role === "user") {
			// User messages in our model can in theory contain non-text chunks,
			// but in practice the UI only produces text. Concatenate any text
			// chunks; ignore anything else.
			const text = msg.chunks
				.filter((c): c is Extract<Chunk, { type: "text" }> => c.type === "text")
				.map((c) => c.text)
				.join("");
			result.push({ role: "user", content: text });
			continue;
		}

		// role === "assistant"
		const parts: Array<
			| { type: "text"; text: string }
			| { type: "reasoning"; text: string }
			| { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
		> = [];
		const trailingToolResults: Array<{
			toolCallId: string;
			toolName: string;
			result: string;
		}> = [];

		for (const chunk of msg.chunks) {
			switch (chunk.type) {
				case "text":
					parts.push({ type: "text", text: chunk.text });
					break;
				case "thinking":
					parts.push({ type: "reasoning", text: chunk.text });
					break;
				case "tool-batch":
					for (const entry of chunk.calls) {
						const toolName = useToolPrefix ? prefixToolName(entry.name) : entry.name;
						parts.push({
							type: "tool-call",
							toolCallId: entry.id,
							toolName,
							args: entry.arguments,
						});
						if (entry.result !== undefined) {
							trailingToolResults.push({
								toolCallId: entry.id,
								toolName,
								result: entry.result,
							});
						}
					}
					break;
				case "error":
				case "system":
					// Strip — not sent back to the LLM.
					break;
			}
		}

		// Skip the assistant message entirely if it has no parts (e.g., a
		// turn that consisted solely of system/error chunks). Emitting an
		// assistant message with empty content can confuse some providers.
		if (parts.length === 0 && trailingToolResults.length === 0) continue;

		if (parts.length > 0) {
			result.push({ role: "assistant", content: parts });
		}

		for (const tr of trailingToolResults) {
			result.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: tr.toolCallId,
						toolName: tr.toolName,
						result: tr.result,
					},
				],
			});
		}
	}
	return result;
}

/**
 * Apply Anthropic prompt-caching breakpoints to a message list.
 *
 * Anthropic caches the entire request prefix up to (and including) any block
 * marked with `cache_control`. Up to 4 breakpoints per request; we use three
 * (first system + last 2 non-system).
 *
 * Strategy (mirrors OpenCode's `applyCaching` in transform.ts):
 *  - Mark the first system message → caches system prompt (and tools, which
 *    sit before messages in the request body).
 *  - Mark the last 2 non-system messages → rolling cache that extends through
 *    the conversation each turn.
 *
 * Only applied for the Anthropic provider. OpenCode Zen's OpenAI-compatible
 * endpoint (`/zen/v1/chat/completions`) backs models like MiniMax, GLM, Kimi,
 * Grok, etc. — those upstreams do automatic prefix caching server-side and
 * don't accept `cache_control` markers. OpenCode's own transform.ts gates
 * `applyCaching` on Anthropic-family detection for the same reason. Models
 * served via `@ai-sdk/openai` (GPT) and `@ai-sdk/google` (Gemini) likewise
 * use server-side automatic caching.
 */
function applyAnthropicCaching(msgs: CoreMessage[]): void {
	const targets = new Set<CoreMessage>();

	const systemMsgs = msgs.filter((m) => m.role === "system").slice(0, 2);
	for (const m of systemMsgs) targets.add(m);

	const nonSystem = msgs.filter((m) => m.role !== "system").slice(-2);
	for (const m of nonSystem) targets.add(m);

	for (const msg of targets) {
		msg.providerOptions = {
			...msg.providerOptions,
			anthropic: {
				...(msg.providerOptions?.anthropic ?? {}),
				cacheControl: { type: "ephemeral" },
			},
		};
	}
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

const MAX_STEPS = 50;

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
			(tc.name === "read_file" ||
				tc.name === "read_file_slice" ||
				tc.name === "write_file" ||
				tc.name === "list_files")
		) {
			const pathArg = typeof tc.arguments.path === "string" ? tc.arguments.path : ".";

			// Canonicalize all three so symlink-in-workdir escapes are detected
			// at the permission gate (not just relative `../` traversal). The
			// helper walks up to the nearest existing ancestor when the leaf
			// doesn't exist (write_file creating new files), so a parent
			// symlink pointing outside the workdir is still caught. The same
			// helper is used inside the tool implementations — keeping the
			// two layers consistent so a path that looks external here also
			// looks external in the tool, and vice versa.
			const resolvedPath = await canonicalize(this.config.workingDirectory, pathArg);
			const resolvedWorkDir = await canonicalize(this.config.workingDirectory);
			const resolvedSpillRoot = await canonicalize(SPILL_ROOT);

			const isUnderWorkdir =
				resolvedPath === resolvedWorkDir || resolvedPath.startsWith(`${resolvedWorkDir}/`);
			// Dispatch's own tool-output spill directory is implicitly allowed —
			// the AI receives a truncation notice pointing here and is expected
			// to read it without prompting the user. Bypassing the external-
			// directory check here keeps the inspection flow frictionless.
			const isSpillPath =
				resolvedPath === resolvedSpillRoot || resolvedPath.startsWith(`${resolvedSpillRoot}/`);

			if (!isUnderWorkdir && !isSpillPath) {
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

			// Compute isError on the raw (untruncated) string so an `Error:` prefix
			// that lives anywhere — including beyond the head excerpt — is still
			// detected. The display result goes through universal truncation so
			// oversized outputs don't blow context. The full content lives in the
			// spill file the truncation notice points to.
			const isError = resultStr.startsWith("Error:");
			const { displayResult } = applyTruncation(resultStr, {
				tabId: this.config.tabId ?? "default",
				callId: tc.id,
				toolName: tc.name,
			});

			return {
				toolCallId: tc.id,
				toolName: tc.name,
				result: displayResult,
				isError,
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

		this.messages.push({ role: "user", chunks: [{ type: "text", text: userMessage }] });

		const registry = createToolRegistry(this.config.tools);
		// `isClaudeOAuth` gates Claude-Code-CLI-specific behavior: billing-header
		// injection, identity preamble, `mcp_*` tool name prefix, and extended
		// thinking config. Only the OAuth flow (provider="anthropic") needs these.
		// `usesAnthropicSDK` is the broader category — any provider whose
		// requests are serialized by `@ai-sdk/anthropic` and therefore expect
		// Anthropic-style `cache_control` markers. Today that's Claude OAuth
		// plus OpenCode Go's MiniMax/Qwen routes.
		const isClaudeOAuth = this.config.provider === "anthropic";
		const usesAnthropicSDK = isClaudeOAuth || this.config.provider === "opencode-anthropic";
		const providerFactory = createProvider({
			apiKey: this.config.apiKey,
			baseURL: this.config.baseURL,
			provider: this.config.provider,
			claudeCredentials: this.config.claudeCredentials,
		});

		// Only the Claude OAuth flow expects `mcp_*` prefixed tool names. The
		// OpenCode Go anthropic-format endpoint passes tools through to MiniMax
		// or Qwen, which expect raw names.
		const aiTools = registry.getAISDKTools();
		const tools = isClaudeOAuth
			? Object.fromEntries(
					Object.entries(aiTools).map(([name, tool]) => [prefixToolName(name), tool]),
				)
			: aiTools;

		// Build system prompt — Claude OAuth requests embed a billing header
		// and the Claude Code identity preamble so Anthropic recognizes the
		// request as coming from the official CLI.
		let systemPrompt = this.config.systemPrompt;
		if (isClaudeOAuth) {
			// `buildBillingHeaderValue` historically took `{ role, content: string }[]`.
			// Project the new chunk-based ChatMessage shape onto that legacy shape
			// by stringifying text chunks. Only the first user message's text is
			// actually used (see extractFirstUserMessageText) — non-text chunks
			// safely contribute nothing.
			const legacyShape = this.messages.map((m) => ({
				role: m.role,
				content: m.chunks
					.filter((c): c is Extract<Chunk, { type: "text" }> => c.type === "text")
					.map((c) => c.text)
					.join(""),
			}));
			const billingHeader = buildBillingHeaderValue(legacyShape);
			systemPrompt = `${billingHeader}\n${SYSTEM_IDENTITY}\n\n${systemPrompt}`;
		}

		try {
			// Single chunk accumulator for the entire assistant turn (all steps).
			// All event-driven mutations go through `appendEventToChunks`.
			const chunks: Chunk[] = [];

			// We build up a local message list for multi-turn within one run() call
			// that includes tool results fed back to the LLM. Each step appends
			// the assistant's evolving chunk list as one ChatMessage; subsequent
			// steps see prior tool calls and their results via the chunks.
			const stepMessages: ChatMessage[] = [...this.messages];
			// The assistant ChatMessage for the current turn, shared across steps
			// so its `chunks` reference matches the accumulator above. We push
			// it once when the first step has actual output to record.
			let assistantTurnMessage: ChatMessage | null = null;

			for (let step = 0; step < MAX_STEPS; step++) {
				const effort = options?.reasoningEffort ?? this.config.reasoningEffort ?? "max";

				// Build stream text options
				const model = providerFactory(this.config.model);

				// Build the message list with the system prompt prepended as a system
				// role message. This is required for Anthropic prompt caching: the
				// `system` shortcut parameter takes a plain string with nowhere to
				// attach `providerOptions.anthropic.cacheControl`. Moving it inline
				// also lets us apply rolling cache breakpoints to the last messages.
				const systemMessage: CoreSystemMessage = { role: "system", content: systemPrompt };
				const coreMessages: CoreMessage[] = [
					systemMessage,
					...toCoreMessages(stepMessages, isClaudeOAuth),
				];

				if (usesAnthropicSDK) {
					applyAnthropicCaching(coreMessages);
				}

				const streamOptions: Parameters<typeof streamText>[0] = {
					model,
					messages: coreMessages,
					tools,
				};

				if (isClaudeOAuth && effort !== "none") {
					// Opus 4.7 rejects `thinking: { type: "enabled" }` ("reasoning-
					// signature without reasoning") and only supports adaptive thinking.
					// `@ai-sdk/anthropic` v1.x can't emit `type: "adaptive"`, so we
					// leave `providerOptions.anthropic.thinking` unset and let the
					// custom fetch in `createClaudeOAuthProvider` inject the adaptive
					// shape into the request body. We still set `maxTokens` here so
					// the SDK serializes it — adaptive thinking spends from this
					// budget rather than a separate one.
					const isOpus47 = this.config.model === "claude-opus-4-7";
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
					if (isOpus47) {
						streamOptions.maxTokens = budgetTokens + 8000;
					} else {
						streamOptions.providerOptions = {
							anthropic: { thinking: { type: "enabled" as const, budgetTokens } },
						};
						streamOptions.maxTokens = budgetTokens + 8000;
					}
				} else if (!usesAnthropicSDK && effort !== "none") {
					streamOptions.providerOptions = { openaiCompatible: { reasoningEffort: effort } };
				}

				const result = streamText(streamOptions);

				// Per-step tool-call tracking — needed because we only loop back
				// to the LLM if this step produced tool calls. The actual chunk
				// state for the turn lives in `chunks`.
				const stepToolCalls: ToolCall[] = [];

				// Ensure we have an assistant message in stepMessages whose
				// `chunks` reference is shared with our accumulator. Only push
				// once; subsequent steps mutate the same chunks array.
				if (assistantTurnMessage === null) {
					assistantTurnMessage = { role: "assistant", chunks };
					stepMessages.push(assistantTurnMessage);
				}

				try {
					for await (const event of result.fullStream) {
						if (event.type === "text-delta") {
							const internalEvent: AgentEvent = {
								type: "text-delta",
								delta: event.textDelta,
							};
							appendEventToChunks(chunks, internalEvent);
							yield internalEvent;
						} else if (event.type === "reasoning") {
							const internalEvent: AgentEvent = {
								type: "reasoning-delta",
								delta: event.textDelta,
							};
							appendEventToChunks(chunks, internalEvent);
							yield internalEvent;
						} else if (event.type === "tool-call") {
							const rawName = event.toolName;
							const toolName = isClaudeOAuth ? unprefixToolName(rawName) : rawName;
							const toolCall: ToolCall = {
								id: event.toolCallId,
								name: toolName,
								arguments: event.args as Record<string, unknown>,
							};
							stepToolCalls.push(toolCall);
							const internalEvent: AgentEvent = { type: "tool-call", toolCall };
							appendEventToChunks(chunks, internalEvent);
							yield internalEvent;
						} else if (event.type === "error") {
							const errRecord = event.error as unknown as Record<string, unknown>;
							const statusCode =
								typeof errRecord.statusCode === "number" ? errRecord.statusCode : undefined;
							const errorMsg = formatError(event.error, this.config);
							const internalEvent: AgentEvent = {
								type: "error",
								error: errorMsg,
								...(statusCode !== undefined ? { statusCode } : {}),
							};
							appendEventToChunks(chunks, internalEvent);
							yield internalEvent;
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
					const tcEvent: AgentEvent = { type: "tool-call", toolCall: badToolCall };
					appendEventToChunks(chunks, tcEvent);
					yield tcEvent;

					const badToolResult: ToolResult = {
						toolCallId: fakeId,
						toolName: badToolName,
						result: errorResult,
						isError: true,
					};
					const trEvent: AgentEvent = { type: "tool-result", toolResult: badToolResult };
					appendEventToChunks(chunks, trEvent);
					yield trEvent;
				}

				// No tool calls means the agent is done — the assistant message
				// already exists in stepMessages with up-to-date chunks.
				if (stepToolCalls.length === 0) {
					break;
				}

				// Execute tool calls manually. Their results merge back into the
				// `chunks` accumulator via `appendEventToChunks`, which routes
				// each result to the correct entry inside its tool-batch chunk.
				// Track which calls already have a recorded result (from the
				// synthetic unavailable-tool error path above) so we don't
				// re-execute them.
				const alreadyResolved = new Set<string>();
				for (const c of chunks) {
					if (c.type !== "tool-batch") continue;
					for (const entry of c.calls) {
						if (entry.result !== undefined) alreadyResolved.add(entry.id);
					}
				}

				for (const tc of stepToolCalls) {
					if (alreadyResolved.has(tc.id)) continue;

					const shellOutputQueue: Array<{ data: string; stream: "stdout" | "stderr" }> = [];

					const execPromise = this.executeToolWithStreaming(tc, shellOutputQueue);

					// Poll for shell output while the tool is running, using Promise.race
					// so we can yield shell-output events as they arrive rather than buffering
					// them all until tool completion.
					let toolResult: ToolResult | undefined;
					while (toolResult === undefined) {
						if (shellOutputQueue.length > 0) {
							const item = shellOutputQueue.shift();
							if (item) {
								const shellEvent: AgentEvent = {
									type: "shell-output",
									data: item.data,
									stream: item.stream,
								};
								appendEventToChunks(chunks, shellEvent);
								yield shellEvent;
							}
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
						if (item) {
							const shellEvent: AgentEvent = {
								type: "shell-output",
								data: item.data,
								stream: item.stream,
							};
							appendEventToChunks(chunks, shellEvent);
							yield shellEvent;
						}
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

					const trEvent: AgentEvent = { type: "tool-result", toolResult: finalToolResult };
					appendEventToChunks(chunks, trEvent);
					yield trEvent;
				}
			}

			// Build the final assistant message from the accumulated chunks.
			// If no assistant turn message was ever created (e.g., the model
			// produced nothing — unusual but possible), synthesize an empty one.
			const assistantMessage: ChatMessage = assistantTurnMessage ?? {
				role: "assistant",
				chunks,
			};
			// `assistantTurnMessage` was pushed into `stepMessages` but not into
			// `this.messages` — push it now so the agent's outward-facing
			// history reflects the turn.
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
						chunks: [{ type: "text", text: userMessages }],
					});
				}
			}

			yield { type: "done", message: assistantMessage };
		} catch (err) {
			const errRecord = err as unknown as Record<string, unknown>;
			const statusCode =
				typeof errRecord.statusCode === "number" ? errRecord.statusCode : undefined;
			const errorMsg = formatError(err, this.config);
			yield { type: "error", error: errorMsg, ...(statusCode !== undefined ? { statusCode } : {}) };
			this.status = "error";
			yield { type: "status", status: "error" };
			return;
		}

		this.status = "idle";
		yield { type: "status", status: "idle" };
	}
}
