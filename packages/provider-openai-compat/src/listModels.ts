import type { ModelInfo } from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";

/**
 * opencode-go specifics (model-list URL, usage/cache-token mapping, headers)
 * live in this generic `provider-openai-compat` for now. When a SECOND
 * OpenAI-compatible backend lands, split this into a generic OpenAI-stream
 * capability exposed as a typed SERVICE handle and a `provider-opencode-go`
 * extension that `dependsOn` it and layers the specifics — coupling via the
 * typed handle only (isolation-over-DRY: no cross-extension code import).
 */

interface OpenAIModelEntry {
	readonly id: string;
}

interface OpenAIModelListResponse {
	readonly data: readonly OpenAIModelEntry[];
}

/**
 * Pure mapping: raw OpenAI-compatible model list → ModelInfo[].
 * Extracted for direct unit testing with no I/O.
 */
export function parseModelList(data: readonly OpenAIModelEntry[]): readonly ModelInfo[] {
	return data.map((entry) => ({ id: entry.id }));
}

export interface ListModelsConfig {
	readonly baseURL: string;
	readonly apiKey: string;
	readonly fetchFn?: FetchLike;
	readonly providerId: string;
}

export async function listModels(config: ListModelsConfig): Promise<readonly ModelInfo[]> {
	const effectiveFetch: FetchLike = config.fetchFn ?? fetch;
	const url = `${config.baseURL}/models`;

	let response: Response;
	try {
		response = await effectiveFetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
			},
		});
	} catch (err) {
		throw new Error(
			`listModels[${config.providerId}]: network error — ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (!response.ok) {
		const text = await response.text().catch(() => "unknown");
		throw new Error(`listModels[${config.providerId}]: HTTP ${response.status} — ${text}`);
	}

	const body = (await response.json()) as OpenAIModelListResponse;
	if (!Array.isArray(body.data)) {
		throw new Error(
			`listModels[${config.providerId}]: unexpected response shape — missing "data" array`,
		);
	}

	return parseModelList(body.data);
}
