import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV1, LanguageModelV1Middleware, LanguageModelV1Prompt } from "ai";
import { wrapLanguageModel } from "ai";

function normalizeMessages(msgs: unknown[]): unknown[] {
	return msgs.map((msg: unknown) => {
		const message = msg as Record<string, unknown>;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return message;

		const content = message.content as Array<Record<string, unknown>>;
		const reasoningParts = content.filter(
			(p) => p.type === "reasoning" || p.type === "redacted-reasoning",
		);
		const reasoningText = reasoningParts.map((p) => p.text ?? "").join("");

		const filteredContent = content.filter(
			(p) => p.type !== "reasoning" && p.type !== "redacted-reasoning",
		);

		const existingMetadata = (message.providerMetadata ?? {}) as Record<string, unknown>;
		const existingOpenAICompat = (existingMetadata.openaiCompatible ?? {}) as Record<
			string,
			unknown
		>;

		return {
			...message,
			content: filteredContent,
			providerMetadata: {
				...existingMetadata,
				openaiCompatible: {
					...existingOpenAICompat,
					reasoning_content: reasoningText,
				},
			},
		};
	});
}

export interface ProviderConfig {
	apiKey: string;
	baseURL: string;
	provider?: string;
	claudeCredentials?: {
		accessToken: string;
	};
}

const MCP_PREFIX = "mcp_";

function prefixToolName(name: string): string {
	return `${MCP_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function unprefixToolName(name: string): string {
	if (name.startsWith(MCP_PREFIX)) {
		const rest = name.slice(MCP_PREFIX.length);
		return `${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
	}
	return name;
}

// Explicit factory return type so the inferred type doesn't leak references
// into transitive `@ai-sdk/provider` paths (which would trip TS2742).
// `@ai-sdk/anthropic` v1.x already returns `LanguageModelV1`-spec models;
// `@ai-sdk/openai-compatible` v0.2.x and `wrapLanguageModel` likewise.
export type ModelFactory = (modelId: string) => LanguageModelV1;

export function createProvider(config: ProviderConfig): ModelFactory {
	if (config.provider === "anthropic") {
		return createClaudeOAuthProvider(config);
	}

	if (config.provider === "opencode-anthropic") {
		return createApiKeyAnthropicProvider(config);
	}

	// Default: OpenAI-compatible provider
	const provider = createOpenAICompatible({
		name: "opencode-zen",
		apiKey: config.apiKey,
		baseURL: config.baseURL,
	});

	return (modelId: string) => {
		const middleware: LanguageModelV1Middleware = {
			middlewareVersion: "v1" as const,
			transformParams: async ({ type, params }) => {
				if (type === "stream" && params.prompt) {
					return {
						...params,
						prompt: normalizeMessages(params.prompt as unknown[]) as LanguageModelV1Prompt,
					};
				}
				return params;
			},
		};

		return wrapLanguageModel({
			model: provider(modelId),
			middleware: [middleware],
		});
	};
}

/**
 * Claude OAuth provider. Used by Dispatch's `anthropic` provider keys
 * (claude-pro, claude-max). Swaps `x-api-key` for `Authorization: Bearer`
 * to satisfy Anthropic's OAuth flow, and mimics Claude Code CLI request
 * headers so the request bills against the user's Claude subscription.
 *
 * The custom fetch also rewrites the outgoing JSON body for Claude Opus 4.7:
 * that model rejects `thinking: { type: "enabled", budget_tokens }` (the only
 * shape `@ai-sdk/anthropic` v1.x can emit) with "reasoning-signature without
 * reasoning", and instead requires `thinking: { type: "adaptive" }`. `ai` v4
 * is pinned to V1-spec providers, so we can't upgrade to v3 of the Anthropic
 * SDK without breaking everything. Doing the rewrite here keeps the rest of
 * the agent path SDK-agnostic and limits the special case to one model.
 */
function createClaudeOAuthProvider(config: ProviderConfig): ModelFactory {
	const accessToken = config.claudeCredentials?.accessToken ?? config.apiKey;

	const customFetch = Object.assign(
		async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			headers.delete("x-api-key");
			headers.set("authorization", `Bearer ${accessToken}`);

			const body = rewriteBodyForOpus47(init?.body);
			return globalThis.fetch(url, { ...init, headers, body });
		},
		{ preconnect: globalThis.fetch.preconnect?.bind(globalThis.fetch) },
	);

	const anthropic = createAnthropic({
		apiKey: "sk-ant-oauth-placeholder",
		baseURL: config.baseURL || "https://api.anthropic.com/v1",
		headers: {
			"anthropic-dangerous-direct-browser-access": "true",
			"x-app": "cli",
			"user-agent": "claude-cli/2.1.112 (external, sdk-cli)",
		},
		fetch: customFetch as typeof globalThis.fetch,
	});

	return (modelId: string) => anthropic(modelId);
}

/**
 * If the request body is a JSON `/messages` payload targeting Claude Opus 4.7
 * and the caller signaled they want thinking (by setting `max_tokens` above
 * Anthropic's default 4096), insert `thinking: { type: "adaptive" }`.
 *
 * Skipping the rewrite when `max_tokens` is small (or absent) keeps `effort:
 * "none"` requests as plain non-thinking calls — agent.ts only sets a high
 * `max_tokens` when thinking is wanted, so this acts as a clean signal.
 *
 * Returns the body unchanged for any other model, any non-string body, or any
 * payload that fails to parse, leaving non-Anthropic providers, non-Opus-4.7
 * Claude models, and streaming/binary uploads unaffected.
 */
function rewriteBodyForOpus47(body: BodyInit | null | undefined): BodyInit | null | undefined {
	if (typeof body !== "string") return body;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return body;
	}
	if (parsed.model !== "claude-opus-4-7") return body;
	const maxTokens = typeof parsed.max_tokens === "number" ? parsed.max_tokens : 0;
	if (maxTokens <= 4096) return body;
	parsed.thinking = { type: "adaptive" };
	// Anthropic rejects requests that combine extended thinking (enabled or
	// adaptive) with any temperature other than 1. `ai` v4 defaults
	// `temperature: 0`, and the v1 Anthropic SDK normally strips it when its
	// own `isThinking` flag is set — but we're injecting `thinking` here,
	// behind the SDK's back, so we have to strip it ourselves. Same for
	// `top_p` and `top_k`, which are likewise rejected with thinking.
	delete parsed.temperature;
	delete parsed.top_p;
	delete parsed.top_k;
	return JSON.stringify(parsed);
}

/**
 * Plain-API-key Anthropic-format provider. Used to hit gateways that speak
 * Anthropic's `/messages` protocol with a standard `x-api-key` header — most
 * importantly OpenCode Go's MiniMax and Qwen routes. Unlike the Claude OAuth
 * variant, no `claudeCredentials` are present, no Claude Code mimicry headers
 * are sent, and the API key is passed verbatim through the SDK's default
 * authentication path.
 */
function createApiKeyAnthropicProvider(config: ProviderConfig): ModelFactory {
	const anthropic = createAnthropic({
		apiKey: config.apiKey,
		baseURL: config.baseURL || "https://opencode.ai/zen/go/v1",
	});

	return (modelId: string) => anthropic(modelId);
}

export { prefixToolName, unprefixToolName };
