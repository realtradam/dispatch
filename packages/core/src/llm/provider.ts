import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";

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
// `@ai-sdk/anthropic` v3.x and `@ai-sdk/openai-compatible` v2.x both return
// `LanguageModelV3`-spec models; `wrapLanguageModel` likewise.
export type ModelFactory = (modelId: string) => LanguageModelV3;

export function createProvider(config: ProviderConfig): ModelFactory {
	if (config.provider === "anthropic") {
		return createClaudeOAuthProvider(config);
	}

	if (config.provider === "opencode-anthropic") {
		return createApiKeyAnthropicProvider(config);
	}

	// Default: OpenAI-compatible provider (OpenCode Zen — DeepSeek, GLM,
	// Kimi, MiniMax, etc.).
	//
	// `@ai-sdk/openai-compatible@2.x` handles reasoning round-tripping
	// natively: it reads `{ type: "reasoning", text }` parts from each
	// assistant message's content and emits them as `reasoning_content`
	// on the wire (see node_modules/@ai-sdk/openai-compatible/dist/index.mjs
	// lines 215-216 and 245). Our `toModelMessages` in agent.ts already
	// emits reasoning parts from `ThinkingChunk`s, so no middleware is
	// needed.
	//
	// (The v4-era `normalizeMessages` middleware that lived here was
	// actively breaking DeepSeek: it stripped reasoning parts from
	// content AND wrote them under `providerMetadata` — wrong key in v3
	// prompts, which use `providerOptions`. The result was that
	// reasoning_content never reached the wire and DeepSeek rejected the
	// follow-up turn with "must be passed back".)
	const provider = createOpenAICompatible({
		name: "opencode-zen",
		apiKey: config.apiKey,
		baseURL: config.baseURL,
	});

	return (modelId: string) => provider(modelId);
}

/**
 * Claude OAuth provider. Used by Dispatch's `anthropic` provider keys
 * (claude-pro, claude-max). Uses `authToken` to send `Authorization: Bearer`
 * (natively supported by `@ai-sdk/anthropic` v3.x), and mimics Claude Code CLI
 * request headers so the request bills against the user's Claude subscription.
 */
function createClaudeOAuthProvider(config: ProviderConfig): ModelFactory {
	const anthropic = createAnthropic({
		baseURL: config.baseURL || "https://api.anthropic.com/v1",
		authToken: config.claudeCredentials?.accessToken ?? config.apiKey,
		headers: {
			"anthropic-dangerous-direct-browser-access": "true",
			"x-app": "cli",
			"user-agent": "claude-cli/2.1.112 (external, sdk-cli)",
		},
	});
	return (modelId: string) => anthropic(modelId);
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
