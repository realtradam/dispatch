import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createOpenAICompatProvider } from "./provider.js";

export const manifest: Manifest = {
	id: "provider-openai-compat",
	name: "OpenAI-Compatible Provider",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	dependsOn: ["auth-apikey"],
	trust: "bundled",
	activation: "eager",
	capabilities: { network: true },
	contributes: { providers: ["openai-compat"] },
};

export async function activate(host: HostAPI): Promise<void> {
	const auth = host.getAuthProvider("apikey");
	if (!auth) {
		host.logger.warn(
			"provider-openai-compat: auth-apikey extension not available. Provider not registered.",
		);
		return;
	}

	const creds = await auth.resolve();
	if (!creds) {
		host.logger.warn(
			"provider-openai-compat: no credentials resolved from auth-apikey. Provider not registered.",
		);
		return;
	}

	if (creds.type !== "api-key") {
		host.logger.warn(
			`provider-openai-compat: expected api-key credentials but got "${creds.type}". Provider not registered.`,
		);
		return;
	}

	const model = host.config.get<string>("provider.openai-compat.model") ?? "deepseek-v4-flash";

	const provider = createOpenAICompatProvider({ credentials: creds, model });
	host.defineProvider(provider);
	host.logger.info(`provider-openai-compat: registered (model=${model})`);
}

export const extension: Extension = {
	manifest,
	activate,
};
