import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function createProvider(config: { apiKey: string; baseURL: string }) {
	return createOpenAICompatible({
		name: "opencode-zen",
		apiKey: config.apiKey,
		baseURL: config.baseURL,
	});
}
