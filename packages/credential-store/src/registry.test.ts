import type { ProviderContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { createCredentialStore } from "./registry.js";

function fakeProvider(
  id: string,
  listModels?: () => Promise<readonly { id: string }[]>,
): ProviderContract {
  return {
    id,
    stream: async function* () {},
    ...(listModels ? { listModels } : {}),
  };
}

describe("createCredentialStore", () => {
  // Numbered OpenCode scheme: a credential + provider per number.
  const credentials = [
    { name: "opencode-1", providerId: "opencode-1" },
    { name: "opencode-2", providerId: "opencode-2" },
  ];
  const providers = new Map<string, ProviderContract>();

  const store = createCredentialStore({
    credentials,
    getProvider: (id) => providers.get(id),
  });

  describe("resolve", () => {
    it("resolves a numbered model name to its matching numbered provider", () => {
      providers.set("opencode-1", fakeProvider("opencode-1"));
      const result = store.resolve("opencode-1/deepseek-v4-flash");
      expect(result).toEqual({ providerId: "opencode-1", model: "deepseek-v4-flash" });
    });

    it("resolves #2 to a DIFFERENT provider than #1 (per-key isolation)", () => {
      providers.set("opencode-2", fakeProvider("opencode-2"));
      const r1 = store.resolve("opencode-1/a");
      const r2 = store.resolve("opencode-2/b");
      expect(r1?.providerId).toBe("opencode-1");
      expect(r2?.providerId).toBe("opencode-2");
    });

    it("does NOT resolve the obsolete opencode/<model> namespace (no opencode credential)", () => {
      const result = store.resolve("opencode/deepseek-v4-flash");
      expect(result).toBeUndefined();
    });

    it("resolves a model name with slashes", () => {
      const result = store.resolve("opencode-1/a/b");
      expect(result).toEqual({ providerId: "opencode-1", model: "a/b" });
    });

    it("returns undefined for unknown credential name", () => {
      const result = store.resolve("unknown/x");
      expect(result).toBeUndefined();
    });

    it("returns undefined for no slash", () => {
      const result = store.resolve("noslash");
      expect(result).toBeUndefined();
    });

    it("returns undefined for empty model segment", () => {
      const result = store.resolve("opencode-1/");
      expect(result).toBeUndefined();
    });
  });

  describe("listCatalog", () => {
    it("lists numbered models from providers with listModels", async () => {
      providers.set(
        "opencode-1",
        fakeProvider("opencode-1", async () => [{ id: "m1" }, { id: "m2" }]),
      );
      providers.set(
        "opencode-2",
        fakeProvider("opencode-2", async () => [{ id: "n1" }]),
      );

      const catalog = await store.listCatalog();
      expect(catalog.sort()).toEqual(["opencode-1/m1", "opencode-1/m2", "opencode-2/n1"]);
    });

    it("skips credentials whose provider has no listModels", async () => {
      providers.set("opencode-1", fakeProvider("opencode-1"));
      const catalog = await store.listCatalog();
      expect(catalog).toEqual(["opencode-2/n1"]);
    });

    it("skips credentials whose provider is missing", async () => {
      const emptyStore = createCredentialStore({
        credentials: [{ name: "opencode-9", providerId: "opencode-9" }],
        getProvider: () => undefined,
      });
      const catalog = await emptyStore.listCatalog();
      expect(catalog).toEqual([]);
    });
  });

  describe("listCatalogDetailed", () => {
    it("returns names + metadata in ONE pass (calls listModels once per provider)", async () => {
      let calls = 0;
      const localProviders = new Map<string, ProviderContract>();
      localProviders.set(
        "opencode-1",
        fakeProvider("opencode-1", async () => {
          calls++;
          return [
            { id: "m1", displayName: "Model One", contextWindow: 64000, vision: true },
            { id: "m2" },
          ];
        }),
      );
      const localStore = createCredentialStore({
        credentials: [{ name: "opencode-1", providerId: "opencode-1" }],
        getProvider: (id) => localProviders.get(id),
      });

      const entries = await localStore.listCatalogDetailed();
      expect(calls).toBe(1); // single upstream list per provider — no duplicate
      expect(entries).toEqual([
        {
          name: "opencode-1/m1",
          info: { id: "m1", displayName: "Model One", contextWindow: 64000, vision: true },
        },
        { name: "opencode-1/m2", info: { id: "m2" } },
      ]);
    });
  });

  describe("getModelInfo", () => {
    it("looks up info for a numbered model, calling listModels once", async () => {
      providers.set(
        "opencode-2",
        fakeProvider("opencode-2", async () => [{ id: "n1", contextWindow: 128000 }]),
      );
      const info = await store.getModelInfo("opencode-2/n1");
      expect(info?.contextWindow).toBe(128000);
    });
  });

  describe("catalog provider failures", () => {
    it.each([
      "first",
      "middle",
      "last",
    ])("keeps healthy models and metadata when the %s provider fails", async (failedId) => {
      const failure = new Error("HTTP 401: api_key_expired");
      const errors: unknown[] = [];
      const ids = ["first", "middle", "last"];
      const localStore = createCredentialStore({
        credentials: ids.map((id) => ({ name: id, providerId: id })),
        getProvider: (id) =>
          fakeProvider(id, async () => {
            if (id === failedId) throw failure;
            return [{ id: "model", contextWindow: 128000, vision: true }];
          }),
        logger: { error: (_message, attrs) => errors.push(attrs) },
      });
      const healthyIds = ids.filter((id) => id !== failedId);

      expect(await localStore.listCatalog()).toEqual(healthyIds.map((id) => `${id}/model`));
      expect(await localStore.listCatalogDetailed()).toEqual(
        healthyIds.map((id) => ({
          name: `${id}/model`,
          info: { id: "model", contextWindow: 128000, vision: true },
        })),
      );
      expect(errors).toEqual([
        { credential: failedId, providerId: failedId, err: failure },
        { credential: failedId, providerId: failedId, err: failure },
      ]);
    });

    it("retries failed providers on the next catalog request, including synchronous failures", async () => {
      let failing = true;
      const localStore = createCredentialStore({
        credentials: [{ name: "opencode-1", providerId: "opencode-1" }],
        getProvider: (id) =>
          fakeProvider(id, () => {
            if (failing) throw new Error("HTTP 401: api_key_expired");
            return Promise.resolve([{ id: "model" }]);
          }),
      });

      expect(await localStore.listCatalog()).toEqual([]);
      expect(await localStore.listCatalogDetailed()).toEqual([]);
      failing = false;
      expect(await localStore.listCatalog()).toEqual(["opencode-1/model"]);
    });
  });
});
