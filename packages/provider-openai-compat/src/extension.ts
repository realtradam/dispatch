import type { ApiKeyCredentials, Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "./provider.js";

export const manifest: Manifest = {
	id: "provider-openai-compat",
	name: "OpenAI-Compatible Provider",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	activation: "eager",
	capabilities: { network: true },
	contributes: { providers: ["openai-compat"] },
};

export function activate(host: HostAPI): void {
	const apiKey = host.config.get<string>("provider.openai-compat.apiKey");
	const baseURL = host.config.get<string>("provider.openai-compat.baseURL");
	const model = host.config.get<string>("provider.openai-compat.model") ?? "deepseek-v4-flash";

	if (!apiKey) {
		host.logger.warn(
			"provider-openai-compat: no API key configured (provider.openai-compat.apiKey). Provider not registered.",
		);
		return;
	}

	const credentials: ApiKeyCredentials = {
		type: "api-key",
		apiKey,
		...(baseURL !== undefined ? { baseURL } : {}),
	};

	const provider = createOpenAICompatProvider({ credentials, model });
	host.defineProvider(provider);
	host.logger.info(`provider-openai-compat: registered (model=${model})`);
}

export const extension: Extension = {
	manifest,
	activate,
};
