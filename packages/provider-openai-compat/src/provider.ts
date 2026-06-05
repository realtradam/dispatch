import type {
	ApiKeyCredentials,
	ChatMessage,
	ModelInfo,
	ProviderContract,
	ProviderStreamOptions,
	ToolContract,
} from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";
import { listModels as fetchModels } from "./listModels.js";
import { streamChat } from "./stream.js";

/**
 * opencode-go specifics (model-list URL, usage/cache-token mapping, headers)
 * live in this generic `provider-openai-compat` for now. When a SECOND
 * OpenAI-compatible backend lands, split this into a generic OpenAI-stream
 * capability exposed as a typed SERVICE handle and a `provider-opencode-go`
 * extension that `dependsOn` it and layers the specifics — coupling via the
 * typed handle only (isolation-over-DRY: no cross-extension code import).
 */

export interface CreateOpenAICompatProviderOpts {
	readonly credentials: ApiKeyCredentials;
	readonly model: string;
	/**
	 * Internal injectable fetch — used by tests and replay mode.
	 * When absent, falls back to globalThis.fetch (production default).
	 */
	readonly fetchFn?: FetchLike;
}

export function createOpenAICompatProvider(opts: CreateOpenAICompatProviderOpts): ProviderContract {
	const baseURL = opts.credentials.baseURL ?? "https://opencode.ai/zen/go/v1";
	const apiKey = opts.credentials.apiKey;
	const fetchFn = opts.fetchFn;

	const streamConfig = {
		baseURL,
		apiKey,
		model: opts.model,
		...(fetchFn !== undefined ? { fetchFn } : {}),
	};

	return {
		id: "openai-compat",
		stream: (
			messages: readonly ChatMessage[],
			tools: readonly ToolContract[],
			streamOpts?: ProviderStreamOptions,
		) => streamChat(streamConfig, messages, tools, streamOpts),
		listModels: (): Promise<readonly ModelInfo[]> =>
			fetchModels({
				baseURL,
				apiKey,
				providerId: "openai-compat",
				...(fetchFn !== undefined ? { fetchFn } : {}),
			}),
	};
}
