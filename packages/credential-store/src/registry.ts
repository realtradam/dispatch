import type { Logger, ModelInfo, ProviderContract } from "@dispatch/kernel";

export interface Credential {
  readonly name: string;
  readonly providerId: string;
}

export interface ResolvedModel {
  readonly providerId: string;
  readonly model: string;
}

/** A fully-qualified `<credentialName>/<model>` entry plus its metadata. */
export interface CatalogEntry {
  /** Fully-qualified model name, e.g. `opencode-1/deepseek-v4-flash`. */
  readonly name: string;
  /** The provider's {@link ModelInfo}. */
  readonly info: ModelInfo;
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
   * missing, has no listModels, or fails to list models.
   */
  listCatalog(): Promise<readonly string[]>;

  /**
   * The model catalog WITH per-model metadata, resolved in ONE pass: for each
   * credential, the provider's `listModels` is called exactly once and each
   * model's {@link ModelInfo} is carried alongside its fully-qualified name.
   * Providers that fail to list models are logged and skipped for this request.
   *
   * This is the single-pass primitive a catalog endpoint (`GET /models`) should
   * use. Consumers that call `listCatalog()` then `getModelInfo()` per entry
   * would re-invoke the provider's upstream model-list per model — that
   * duplicate is exactly what this avoids.
   */
  listCatalogDetailed(): Promise<readonly CatalogEntry[]>;

  /**
   * Returns the full `ModelInfo` for a `<credentialName>/<model>` string, or
   * undefined if unknown. Caches the result of `listModels` per credential.
   * Used to look up `contextWindow` for auto-compaction.
   */
  getModelInfo(modelName: string): Promise<ModelInfo | undefined>;
}

export interface CredentialStoreDeps {
  readonly credentials: readonly Credential[];
  readonly getProvider: (id: string) => ProviderContract | undefined;
  readonly logger?: Pick<Logger, "error">;
}

/**
 * Resolve the full catalog with metadata in ONE pass. For each credential we
 * invoke its provider's `listModels` exactly once, emitting every model under
 * the credential's fully-qualified namespace with its {@link ModelInfo}. This
 * is the shared primitive behind `listCatalog` (names only) and
 * `listCatalogDetailed` (names + info), so callers never double-fetch the
 * upstream model list.
 */
async function listCatalogDetailedInternal(
  deps: CredentialStoreDeps,
): Promise<readonly CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  for (const credential of deps.credentials) {
    const provider = deps.getProvider(credential.providerId);
    if (!provider?.listModels) {
      continue;
    }
    let models: readonly ModelInfo[];
    try {
      models = await provider.listModels();
    } catch (err) {
      deps.logger?.error("catalog: failed to list models for credential", {
        credential: credential.name,
        providerId: credential.providerId,
        err,
      });
      continue;
    }
    for (const model of models) {
      entries.push({ name: `${credential.name}/${model.id}`, info: model });
    }
  }
  return entries;
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
      const entries = await listCatalogDetailedInternal(deps);
      return entries.map((e) => e.name);
    },

    async listCatalogDetailed(): Promise<readonly CatalogEntry[]> {
      return listCatalogDetailedInternal(deps);
    },

    async getModelInfo(modelName: string): Promise<ModelInfo | undefined> {
      const slashIndex = modelName.indexOf("/");
      if (slashIndex === -1) return undefined;
      const credentialName = modelName.slice(0, slashIndex);
      const modelId = modelName.slice(slashIndex + 1);
      if (!modelId) return undefined;

      const providerId = credentialMap.get(credentialName);
      if (providerId === undefined) return undefined;

      const provider = deps.getProvider(providerId);
      if (provider?.listModels === undefined) return undefined;

      const models = await provider.listModels();
      return models.find((m) => m.id === modelId);
    },
  };
}
