import type {
	ApiKeyCredentials,
	ChatMessage,
	ProviderContract,
	ProviderStreamOptions,
	ToolContract,
} from "@dispatch/kernel";
import { streamChat } from "./stream.js";

export interface CreateOpenAICompatProviderOpts {
	readonly credentials: ApiKeyCredentials;
	readonly model: string;
}

export function createOpenAICompatProvider(opts: CreateOpenAICompatProviderOpts): ProviderContract {
	const config = {
		baseURL: opts.credentials.baseURL ?? "https://opencode.ai/zen/go/v1",
		apiKey: opts.credentials.apiKey,
		model: opts.model,
	};

	return {
		id: "openai-compat",
		stream: (
			messages: readonly ChatMessage[],
			tools: readonly ToolContract[],
			streamOpts?: ProviderStreamOptions,
		) => streamChat(config, messages, tools, streamOpts),
	};
}
