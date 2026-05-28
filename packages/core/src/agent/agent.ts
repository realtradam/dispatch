import { dirname } from "node:path";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ModelMessage, SystemModelMessage } from "ai";
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
 * Rebuild AI SDK `ModelMessage[]` from our internal `ChatMessage[]`.
 *
 * Strip rules (see plan-chunk-refactor.md):
 *  - `role: "system"` messages are skipped wholesale (they're display-only
 *    standalone-system bubbles that exist outside any model turn).
 *  - `error` chunks are skipped — the turn ended; the LLM doesn't need them.
 *  - `system` chunks are skipped — display-only notices.
 *  - `text` chunks → `{ type: "text", text }` parts.
 *  - `thinking` chunks → `{ type: "reasoning", text, providerOptions? }` parts.
 *    The `providerOptions` carries the Anthropic signature blob (if present) so
 *    Anthropic can validate extended-thinking round-trips. Non-Anthropic
 *    reasoning has no metadata and is sent without providerOptions (accepted
 *    by Anthropic — it just won't verify a missing signature).
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
/**
 * Marker used to identify the start of a `[USER INTERRUPT]` block embedded
 * in a tool result. Both the agent-level injection
 * (`packages/core/src/agent/agent.ts`) and the tool-level injections in
 * `run-shell`, `youtube-transcribe`, and `retrieve` use the same separator
 * (`\n\n[USER INTERRUPT]`) before the boilerplate, so a single substring
 * search suffices for stripping.
 */
const USER_INTERRUPT_MARKER = "\n\n[USER INTERRUPT]";

/**
 * Remove the `[USER INTERRUPT]` block (and everything after it) from a tool
 * result string. Used when a historical tool-result is being re-serialized
 * for the LLM and the model has already had a chance to address that
 * interrupt — leaving the imperative "You MUST address these" text in
 * place causes the model to re-acknowledge the same interrupt on every
 * subsequent step.
 *
 * The interrupt block is always appended to the end of the tool result, so
 * we strip from the marker to end-of-string.
 */
function stripUserInterruptBlock(result: string): string {
	const idx = result.indexOf(USER_INTERRUPT_MARKER);
	if (idx === -1) return result;
	return result.slice(0, idx);
}

function toModelMessages(messages: ChatMessage[], useToolPrefix?: boolean): ModelMessage[] {
	const result: ModelMessage[] = [];

	// A `[USER INTERRUPT]` block in a tool-result is "fresh" — i.e., the
	// model has not yet seen and responded to it — only when ALL of these
	// hold:
	//   1. The tool-batch is in the very last message of the history.
	//   2. That message is an assistant message (a follow-up user message
	//      means the user moved on; the interrupt was addressed).
	//   3. The tool-batch is the LAST chunk in that message (any later
	//      text/thinking/tool-batch in the same message represents the
	//      model's response to the tool results).
	//
	// All other interrupts get stripped from history because the imperative
	// "You MUST address these" otherwise gets re-evaluated as a fresh
	// instruction on every subsequent LLM step.
	let freshestToolBatchMsgIdx = -1;
	let freshestToolBatchChunkIdx = -1;
	const lastMsgIdx = messages.length - 1;
	const lastMsg = messages[lastMsgIdx];
	if (lastMsg && lastMsg.role === "assistant" && lastMsg.chunks.length > 0) {
		const lastChunkIdx = lastMsg.chunks.length - 1;
		const lastChunk = lastMsg.chunks[lastChunkIdx];
		if (lastChunk && lastChunk.type === "tool-batch") {
			freshestToolBatchMsgIdx = lastMsgIdx;
			freshestToolBatchChunkIdx = lastChunkIdx;
		}
	}

	for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
		const msg = messages[msgIdx];
		if (!msg || msg.role === "system") continue;

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
			| { type: "reasoning"; text: string; providerOptions?: ProviderOptions }
			| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
		> = [];
		const trailingToolResults: Array<{
			toolCallId: string;
			toolName: string;
			result: string;
		}> = [];

		for (let chunkIdx = 0; chunkIdx < msg.chunks.length; chunkIdx++) {
			const chunk = msg.chunks[chunkIdx];
			if (!chunk) continue;
			switch (chunk.type) {
				case "text":
					parts.push({ type: "text", text: chunk.text });
					break;
				case "thinking":
					// v6: carry providerOptions (Anthropic signature blob) if present.
					// Non-Anthropic reasoning has no metadata → send without providerOptions
					// (Anthropic accepts it; the round-trip just won't carry a signature).
					parts.push({
						type: "reasoning",
						text: chunk.text,
						...(chunk.metadata !== undefined
							? { providerOptions: chunk.metadata as ProviderOptions }
							: {}),
					});
					break;
				case "tool-batch": {
					// Strip stale `[USER INTERRUPT]` blocks from every
					// tool-batch except the freshest one (most recent
					// tool-batch in the most recent assistant message).
					// Without this, the imperative "You MUST address these"
					// text persists in history and the model re-acknowledges
					// the same interrupt verbatim on every subsequent step.
					const isFreshestToolBatch =
						msgIdx === freshestToolBatchMsgIdx && chunkIdx === freshestToolBatchChunkIdx;
					for (const entry of chunk.calls) {
						const toolName = useToolPrefix ? prefixToolName(entry.name) : entry.name;
						// v6: `input` replaces v4's `args`
						parts.push({
							type: "tool-call",
							toolCallId: entry.id,
							toolName,
							input: entry.arguments,
						});
						if (entry.result !== undefined) {
							const resultText = isFreshestToolBatch
								? entry.result
								: stripUserInterruptBlock(entry.result);
							trailingToolResults.push({
								toolCallId: entry.id,
								toolName,
								result: resultText,
							});
						}
					}
					break;
				}
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
			// v6: `output` (ToolResultOutput) replaces v4's `result` (raw string)
			result.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: tr.toolCallId,
						toolName: tr.toolName,
						output: { type: "text" as const, value: tr.result },
					},
				],
			});
		}
	}
	return result;
}

/**
 * Apply OpenAI-compatible reasoning normalisation.
 *
 * Cribbed from opencode `provider/transform.ts:217-249`. Solves DeepSeek's
 * "The reasoning_content in the thinking mode must be passed back to the
 * API" error.
 *
 * The v6 `@ai-sdk/openai-compatible@2.x` provider extracts `reasoning_content`
 * from assistant `{ type: "reasoning", text }` parts natively
 * (see `node_modules/@ai-sdk/openai-compatible/dist/index.mjs:215-216` and :245).
 * But that native path SKIPS emission when `reasoning.length === 0` —
 * "reasoning_content" is omitted from the wire. DeepSeek (and similar
 * "thinking mode" providers) require the field to be present in every
 * follow-up turn once it was emitted at least once, even if the value is
 * the empty string.
 *
 * Strategy: for every assistant message that has any `reasoning` parts,
 * concatenate their text into `providerOptions.openaiCompatible.reasoning_content`
 * (preserving empty strings) AND strip those parts from content. The
 * resulting payload has a single source of truth for `reasoning_content`
 * coming via the message-level `providerOptions` spread at line 247 of the
 * SDK provider, which fires regardless of empty-vs-non-empty text.
 *
 * Only applied for the default (non-Anthropic) openai-compatible path.
 */
function applyOpenAICompatibleReasoningNormalisation(msgs: ModelMessage[]): ModelMessage[] {
	return msgs.map((msg) => {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;

		// Find reasoning parts. If there are none, this message never had
		// a thinking turn — DeepSeek doesn't require `reasoning_content`
		// in that case, so we pass through unchanged.
		const reasoningParts = msg.content.filter(
			(p): p is Extract<typeof p, { type: "reasoning" }> => p.type === "reasoning",
		);
		if (reasoningParts.length === 0) return msg;

		const reasoningText = reasoningParts.map((p) => p.text).join("");
		const filteredContent = msg.content.filter((p) => p.type !== "reasoning");

		const existingOpts = msg.providerOptions ?? {};
		const existingCompat = (existingOpts.openaiCompatible ?? {}) as Record<string, unknown>;

		return {
			...msg,
			content: filteredContent,
			providerOptions: {
				...existingOpts,
				openaiCompatible: {
					...existingCompat,
					// Always set, even when empty. This is the key fix —
					// the SDK's content-side extraction skips empty
					// reasoning, but DeepSeek requires the field present.
					reasoning_content: reasoningText,
				},
			},
		} as ModelMessage;
	});
}

/**
 * Apply Anthropic structural normalisations to a `ModelMessage[]`.
 *
 * Cribbed from opencode `provider/transform.ts:53-148`. Two passes:
 *
 * 1. **Empty-text/reasoning filter**: Drop `text` / `reasoning` parts
 *    whose `text === ""`. Drop messages whose content array becomes
 *    empty. Anthropic rejects assistant turns with empty content.
 *
 * 2. **`toolCallId` scrubbing**: Anthropic only accepts tool call IDs
 *    that match `[a-zA-Z0-9_-]`. Our IDs are crypto.randomUUID() values
 *    which are already safe, but tool-call IDs assigned by upstream
 *    sources (provider-executed tools, subagent retrieval, etc.) may
 *    not be. Defensively scrub. Mirrors opencode `provider/transform.ts:96-122`.
 *
 * 3. **`[tool-call, text]` split**: Anthropic rejects assistant turns
 *    where `tool_use` blocks are followed by non-tool-call content
 *    ("`tool_use` ids were found without `tool_result` blocks immediately
 *    after"). If an assistant message has mixed ordering, split it into
 *    `[non-tool parts] + [tool-call parts]`.
 *
 * Only applied for Anthropic-backed providers (Claude OAuth or
 * opencode-anthropic). Skip for openai-compatible / OpenCode Zen.
 */
const SCRUB_TOOL_CALL_ID = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function applyAnthropicStructuralNormalisations(msgs: ModelMessage[]): ModelMessage[] {
	// Pass 1: Filter empty text/reasoning parts; drop messages that become empty.
	msgs = msgs
		.map((msg) => {
			if (typeof msg.content === "string") {
				if (msg.content === "") return undefined;
				return msg;
			}
			if (!Array.isArray(msg.content)) return msg;
			const filtered = msg.content.filter((part) => {
				if (part.type === "text" || part.type === "reasoning") {
					return (part as { text: string }).text !== "";
				}
				return true;
			});
			if (filtered.length === 0) return undefined;
			return { ...msg, content: filtered };
		})
		.filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "");

	// Pass 2: Scrub toolCallId chars on both assistant tool-call parts and
	// tool-role tool-result parts. Anthropic rejects anything outside
	// [a-zA-Z0-9_-]. Our internal IDs are crypto.randomUUID() and safe, but
	// upstream provider-executed tools or external sources may not be.
	msgs = msgs.map((msg) => {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: msg.content.map((part) => {
					if (part.type === "tool-call" || part.type === "tool-result") {
						return { ...part, toolCallId: SCRUB_TOOL_CALL_ID(part.toolCallId) };
					}
					return part;
				}),
			};
		}
		if (msg.role === "tool" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: msg.content.map((part) => {
					if (part.type === "tool-result") {
						return { ...part, toolCallId: SCRUB_TOOL_CALL_ID(part.toolCallId) };
					}
					return part;
				}),
			};
		}
		return msg;
	});

	// Pass 3: Split assistant messages where tool-calls are followed by non-tool-call parts.
	// [text, tool-call, text] → [text, text] + [tool-call] (text-only first, tools-only second)
	msgs = msgs.flatMap((msg) => {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [msg];
		const parts = msg.content;
		const firstToolCallIdx = parts.findIndex((part) => part.type === "tool-call");
		if (firstToolCallIdx === -1) return [msg]; // no tool calls → pass through
		// If everything from the first tool-call onward is also a tool-call, it's already valid
		if (!parts.slice(firstToolCallIdx).some((part) => part.type !== "tool-call")) return [msg];
		// Has non-tool-call content AFTER a tool-call → split
		const nonToolParts = parts.filter((part) => part.type !== "tool-call");
		const toolParts = parts.filter((part) => part.type === "tool-call");
		return [
			{ ...msg, content: nonToolParts },
			{ ...msg, content: toolParts },
		];
	});

	return msgs;
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
function applyAnthropicCaching(msgs: ModelMessage[]): void {
	const targets = new Set<ModelMessage>();

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
				const systemMessage: SystemModelMessage = {
					role: "system",
					content: systemPrompt,
				};

				let coreMessages: ModelMessage[] = [
					systemMessage,
					...toModelMessages(stepMessages, isClaudeOAuth),
				];

				// Apply provider-specific structural normalisations before
				// sending. Anthropic and openai-compatible paths each have
				// their own message-shape requirements; the two passes are
				// mutually exclusive.
				if (usesAnthropicSDK) {
					coreMessages = applyAnthropicStructuralNormalisations(coreMessages);
					applyAnthropicCaching(coreMessages);
				} else {
					coreMessages = applyOpenAICompatibleReasoningNormalisation(coreMessages);
				}

				const streamOptions: Parameters<typeof streamText>[0] = {
					model,
					messages: coreMessages,
					tools,
				};

				if (isClaudeOAuth && effort !== "none") {
					// v6 native support for Opus 4.7 adaptive thinking via
					// providerOptions. No more rewriteBodyForOpus47 body-
					// injection hack needed.
					//
					// Budgets mirror opencode transform.ts:
					//   - max  budget = 31999 (Anthropic's documented ceiling;
					//     `Math.min(31_999, model.limit.output - 1)` in
					//     opencode line 668)
					//   - high budget = 16000 (opencode line 662:
					//     `Math.min(16_000, Math.floor(model.limit.output/2-1))`)
					//   - medium/low: no opencode equivalent — sensible
					//     intermediate defaults.
					//
					// `maxOutputTokens` is the TOTAL output cap (thinking +
					// response combined). Anthropic's standard output max is
					// 32K for Claude 4.x; matching opencode's OUTPUT_TOKEN_MAX
					// constant. The `budget_tokens` field is a thinking
					// ceiling, not a requirement, so the model self-regulates
					// thinking vs response within this total budget.
					//
					// Opus 4.7 (adaptive) specifics (mirrors opencode
					// transform.ts:642-655):
					//   - `thinking.type = "adaptive"` — the model decides how
					//     much to think within `maxOutputTokens`.
					//   - `thinking.display = "summarized"` — adaptive thinking
					//     for Opus 4.7 defaults to `display: "omitted"`, which
					//     means NO thinking content is streamed to us. Setting
					//     `summarized` is what makes the thinking visible in
					//     the UI.
					//   - `effort` (sibling of `thinking`) — adaptive needs an
					//     explicit effort level. Without it, Anthropic uses a
					//     conservative default and the model barely thinks.
					const isOpus47 = this.config.model === "claude-opus-4-7";
					const budgetTokens =
						effort === "max"
							? 31999
							: effort === "high"
								? 16000
								: effort === "medium"
									? 5000
									: effort === "low"
										? 2000
										: 0;
					// Cap at Anthropic's standard 32K output (matches opencode's
					// OUTPUT_TOKEN_MAX); the model splits this between thinking
					// (up to budgetTokens) and response.
					streamOptions.maxOutputTokens = 32000;
					streamOptions.providerOptions = {
						anthropic: isOpus47
							? {
									thinking: { type: "adaptive" as const, display: "summarized" as const },
									effort,
								}
							: { thinking: { type: "enabled" as const, budgetTokens } },
					};
				} else if (!usesAnthropicSDK && effort !== "none") {
					// OpenAI-compatible models (OpenCode Zen: DeepSeek, GLM,
					// Kimi, etc.). The `reasoningEffort` field is forwarded
					// verbatim to providers that support it. `"max"` is the
					// strongest level we expose; the provider may map it
					// internally (e.g. DeepSeek interprets it as deep
					// reasoning).
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
							// v6: text-delta carries `text` (not `textDelta`)
							const internalEvent: AgentEvent = {
								type: "text-delta",
								delta: event.text,
							};
							appendEventToChunks(chunks, internalEvent);
							yield internalEvent;
						} else if (event.type === "reasoning-delta") {
							// v6 new event: reasoning-delta carries `text` (not `textDelta`)
							const internalEvent: AgentEvent = {
								type: "reasoning-delta",
								delta: event.text,
							};
							appendEventToChunks(chunks, internalEvent);
							yield internalEvent;
						} else if (event.type === "reasoning-end") {
							// Only emit when providerMetadata is present — non-Anthropic
							// models send reasoning-end without any metadata to round-trip.
							// Anthropic's signature lives inside providerMetadata as
							// { anthropic: { signature: "..." } }.
							if (event.providerMetadata !== undefined) {
								const internalEvent: AgentEvent = {
									type: "reasoning-end",
									metadata: event.providerMetadata as Record<string, unknown>,
								};
								appendEventToChunks(chunks, internalEvent);
								yield internalEvent;
							}
						} else if (event.type === "tool-call") {
							// v6: tool call input is in `input` (not `args`)
							const rawName = event.toolName;
							const toolName = isClaudeOAuth ? unprefixToolName(rawName) : rawName;
							const toolCall: ToolCall = {
								id: event.toolCallId,
								name: toolName,
								arguments: event.input as Record<string, unknown>,
							};
							stepToolCalls.push(toolCall);
							const internalEvent: AgentEvent = { type: "tool-call", toolCall };
							appendEventToChunks(chunks, internalEvent);
							yield internalEvent;
						} else if (event.type === "tool-error") {
							// Anthropic-side / provider-executed tool failures
							// (e.g. server tools or repair-tool-call paths) surface
							// as a fresh stream event rather than as a thrown
							// `tool-result` from our manual executor. Forward both
							// a synthetic tool-result (so the tool-batch entry the
							// model expects has an `isError: true` result) and
							// abort the step as an error chunk — without this the
							// model would silently wait for a result that never
							// arrives.
							const evt = event as unknown as {
								toolCallId: string;
								toolName: string;
								error: unknown;
							};
							const toolName = isClaudeOAuth ? unprefixToolName(evt.toolName) : evt.toolName;
							const errMessage = evt.error instanceof Error ? evt.error.message : String(evt.error);

							const trEvent: AgentEvent = {
								type: "tool-result",
								toolResult: {
									toolCallId: evt.toolCallId,
									toolName,
									result: `Error: ${errMessage}`,
									isError: true,
								},
							};
							appendEventToChunks(chunks, trEvent);
							yield trEvent;

							const errorMsg = formatError(evt.error, this.config);
							const errChunkEvent: AgentEvent = { type: "error", error: errorMsg };
							appendEventToChunks(chunks, errChunkEvent);
							yield errChunkEvent;
							this.status = "error";
							yield { type: "status", status: "error" };
							return;
						} else if (event.type === "abort") {
							// Stream aborted upstream. Surface as an error so the
							// frontend tab transitions out of `running`. We don't
							// currently call abortController.abort() ourselves, so
							// this would only fire from external signal propagation.
							const reason =
								typeof (event as { reason?: unknown }).reason === "string"
									? (event as { reason: string }).reason
									: "stream aborted";
							const errorMsg = formatError(new Error(reason), this.config);
							const internalEvent: AgentEvent = { type: "error", error: errorMsg };
							appendEventToChunks(chunks, internalEvent);
							yield internalEvent;
							this.status = "error";
							yield { type: "status", status: "error" };
							return;
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
						// Ignored events (intentional):
						//   start, text-start, text-end, reasoning-start,
						//   tool-input-start, tool-input-delta, tool-input-end,
						//   tool-result (only fires if tool has execute; ours don't),
						//   start-step, finish-step, finish, raw,
						//   source, file, tool-output-denied, tool-approval-*
					}
				} catch (streamErr) {
					const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
					// v6 SDK error message: "Model tried to call unavailable tool '...'"
					// (v4 was: "tried to call unavailable tool '...'")
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

				// Identify the index of the last tool in this batch that will
				// actually execute. Queued user messages are buffered across
				// this batch and injected into ONLY that tool's result, so the
				// interrupt appears exactly once per step rather than fragmented
				// across whichever tool happened to dequeue first. Tool-level
				// interrupt handlers in run-shell/youtube-transcribe/retrieve
				// still embed their own interrupt text in their return values —
				// that path is independent and remains correct.
				let lastExecutableIdx = -1;
				for (let i = 0; i < stepToolCalls.length; i++) {
					const tcAt = stepToolCalls[i];
					if (tcAt && !alreadyResolved.has(tcAt.id)) lastExecutableIdx = i;
				}

				// Accumulator for messages dequeued during this batch. Drained
				// only at `lastExecutableIdx`. Destructive dequeue at the queue
				// level prevents the same message from appearing in subsequent
				// batches.
				const batchPendingInjection: { id: string; message: string; timestamp: number }[] = [];

				for (let tcIdx = 0; tcIdx < stepToolCalls.length; tcIdx++) {
					const tc = stepToolCalls[tcIdx];
					if (!tc || alreadyResolved.has(tc.id)) continue;

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

					// Harvest any queued user messages but DEFER injection until
					// the last tool of the batch. This collapses multiple
					// queued messages into a single interrupt block on a single
					// tool-result instead of fragmenting across the batch.
					if (this.queueCallbacks) {
						const queuedMsgs = this.queueCallbacks.dequeueMessages();
						if (queuedMsgs.length > 0) {
							batchPendingInjection.push(...queuedMsgs);
						}
					}

					let finalToolResult = toolResult;
					if (tcIdx === lastExecutableIdx && batchPendingInjection.length > 0) {
						const userMessages = batchPendingInjection.map((m) => m.message).join("\n---\n");
						finalToolResult = {
							...toolResult,
							result: `${toolResult.result}\n\n[USER INTERRUPT]\nThe user has sent you message(s) while you were working. You MUST address these before continuing with your current task:\n\n${userMessages}`,
						};
						batchPendingInjection.length = 0;
					}

					const trEvent: AgentEvent = { type: "tool-result", toolResult: finalToolResult };
					appendEventToChunks(chunks, trEvent);
					yield trEvent;
				}

				// Safety net: if `lastExecutableIdx` was never reached (e.g.,
				// no tools executed because all were already resolved) but
				// messages were still dequeued, surface them as a user message
				// so they aren't dropped. In practice this is rare — it only
				// happens when the entire batch is unavailable-tool synthesized
				// errors with a message arriving in that narrow window.
				if (batchPendingInjection.length > 0) {
					const userMessages = batchPendingInjection.map((m) => m.message).join("\n---\n");
					this.messages.push({
						role: "user",
						chunks: [{ type: "text", text: userMessages }],
					});
					batchPendingInjection.length = 0;
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
