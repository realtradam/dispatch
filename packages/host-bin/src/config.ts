import type { ConfigAccess } from "@dispatch/kernel";

export function envToConfigMap(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
	const map: Record<string, unknown> = {};

	const apiKey = env.DISPATCH_API_KEY;
	if (apiKey !== undefined) {
		map["provider.openai-compat.apiKey"] = apiKey;
	}

	const baseURL = env.DISPATCH_BASE_URL;
	if (baseURL !== undefined) {
		map["provider.openai-compat.baseURL"] = baseURL;
	}

	const model = env.DISPATCH_MODEL;
	if (model !== undefined) {
		map["provider.openai-compat.model"] = model;
	}

	const httpPort = env.BACKEND_PORT ?? env.PORT;
	if (httpPort !== undefined) {
		const n = Number(httpPort);
		if (Number.isFinite(n) && n > 0) {
			map.httpPort = n;
		}
	}

	return map;
}

export function configMapToAccess(map: Readonly<Record<string, unknown>>): ConfigAccess {
	return {
		get<T = unknown>(key: string): T | undefined {
			return map[key] as T | undefined;
		},
		getAll(): Readonly<Record<string, unknown>> {
			return map;
		},
	};
}
