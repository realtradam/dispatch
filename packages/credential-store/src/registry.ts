import type { ProviderContract } from "@dispatch/kernel";

export interface Credential {
	readonly name: string;
	readonly providerId: string;
}

export interface ResolvedModel {
	readonly providerId: string;
	readonly model: string;
}

export interface CredentialStore {
	/**
	 * Split a model name on the FIRST "/": name=before, model=after (model may contain "/").
	 * Look up the credential by name; return its providerId + the model id, or undefined if
	 * the name is unknown or there is no model segment.
	 */
	resolve(modelName: string): ResolvedModel | undefined;

	/**
	 * The model catalog: for each credential, look up its provider and call listModels(),
	 * emitting `${credential.name}/${modelInfo.id}`. Skip credentials whose provider is
	 * missing or has no listModels.
	 */
	listCatalog(): Promise<readonly string[]>;
}

export interface CredentialStoreDeps {
	readonly credentials: readonly Credential[];
	readonly getProvider: (id: string) => ProviderContract | undefined;
}

export function createCredentialStore(deps: CredentialStoreDeps): CredentialStore {
	const credentialMap = new Map<string, string>();
	for (const credential of deps.credentials) {
		credentialMap.set(credential.name, credential.providerId);
	}

	return {
		resolve(modelName: string): ResolvedModel | undefined {
			const slashIndex = modelName.indexOf("/");
			if (slashIndex === -1) {
				return undefined;
			}

			const credentialName = modelName.slice(0, slashIndex);
			const model = modelName.slice(slashIndex + 1);

			if (!model) {
				return undefined;
			}

			const providerId = credentialMap.get(credentialName);
			if (!providerId) {
				return undefined;
			}

			return { providerId, model };
		},

		async listCatalog(): Promise<readonly string[]> {
			const results: string[] = [];

			for (const credential of deps.credentials) {
				const provider = deps.getProvider(credential.providerId);
				if (!provider?.listModels) {
					continue;
				}

				const models = await provider.listModels();
				for (const model of models) {
					results.push(`${credential.name}/${model.id}`);
				}
			}

			return results;
		},
	};
}
