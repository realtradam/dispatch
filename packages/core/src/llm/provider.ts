import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV1Middleware, LanguageModelV1Prompt } from "ai";
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

export function createProvider(config: ProviderConfig) {
	if (config.provider === "anthropic") {
		return createAnthropicProvider(config);
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

function createAnthropicProvider(config: ProviderConfig) {
	const accessToken = config.claudeCredentials?.accessToken ?? config.apiKey;

	const customFetch = Object.assign(
		async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			headers.delete("x-api-key");
			headers.set("authorization", `Bearer ${accessToken}`);
			return globalThis.fetch(url, { ...init, headers });
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

	return (modelId: string) => {
		return anthropic(modelId);
	};
}

export { prefixToolName, unprefixToolName };
