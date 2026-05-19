import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import type { LanguageModelV1Middleware, LanguageModelV1Prompt } from "ai";

/**
 * Normalize messages for interleaved reasoning providers (DeepSeek).
 * Extracts { type: "reasoning" } / { type: "redacted-reasoning" } parts from
 * assistant message content arrays and moves them into
 * providerMetadata.openaiCompatible.reasoning_content so
 * @ai-sdk/openai-compatible serializes them correctly for the API.
 *
 * IMPORTANT: The messages in params.prompt are already in LanguageModelV1Prompt
 * format (post-conversion by the AI SDK). They use `providerMetadata`, NOT
 * `providerOptions` — that conversion happens before the middleware runs.
 */
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
		const existingOpenAICompat = (existingMetadata.openaiCompatible ?? {}) as Record<string, unknown>;

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

export function createProvider(config: { apiKey: string; baseURL: string }) {
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
