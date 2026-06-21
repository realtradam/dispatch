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
 * Generic factory for an OpenAI-compatible provider. A provider extension
 * supplies its own `id` (stamped on the ProviderContract + used in listModels
 * error labels) and an optional `transformBody` hook to add provider-specific
 * body fields (e.g. `reasoning_effort`) before the request is sent. The library
 * names no concrete feature — those knobs belong to the extension layer.
 */

export interface CreateOpenAICompatProviderOpts {
	readonly credentials: ApiKeyCredentials;
	readonly model: string;
	/** Provider id (was hardcoded "openai-compat"). Stamped on the ProviderContract.id
	 *  + used in listModels error labels. */
	readonly id: string;
	/**
	 * Internal injectable fetch — used by tests and replay mode.
	 * When absent, falls back to globalThis.fetch (production default).
	 */
	readonly fetchFn?: FetchLike;
	/**
	 * Optional hook a provider extension uses to add provider-specific body fields (e.g.
	 * `reasoning_effort`) before the request is sent. Receives the body built so far +
	 * the ProviderStreamOptions; returns ADDITIONAL fields to merge (or the full body).
	 * Default (absent): no extra fields. Generic — the library names no feature.
	 */
	readonly transformBody?: (
		body: Record<string, unknown>,
		opts: ProviderStreamOptions,
	) => Record<string, unknown>;
}

export function createOpenAICompatProvider(opts: CreateOpenAICompatProviderOpts): ProviderContract {
	const baseURL = opts.credentials.baseURL ?? "https://opencode.ai/zen/go/v1";
	const apiKey = opts.credentials.apiKey;
	const fetchFn = opts.fetchFn;
	const transformBody = opts.transformBody;

	const streamConfig = {
		baseURL,
		apiKey,
		model: opts.model,
		...(fetchFn !== undefined ? { fetchFn } : {}),
		...(transformBody !== undefined ? { transformBody } : {}),
	};

	return {
		id: opts.id,
		stream: (
			messages: readonly ChatMessage[],
			tools: readonly ToolContract[],
			streamOpts?: ProviderStreamOptions,
		) => streamChat(streamConfig, messages, tools, streamOpts),
		listModels: (): Promise<readonly ModelInfo[]> =>
			fetchModels({
				baseURL,
				apiKey,
				providerId: opts.id,
				...(fetchFn !== undefined ? { fetchFn } : {}),
			}),
	};
}
