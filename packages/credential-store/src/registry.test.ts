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
	const credentials = [{ name: "opencode", providerId: "openai-compat" }];
	const providers = new Map<string, ProviderContract>();

	const store = createCredentialStore({
		credentials,
		getProvider: (id) => providers.get(id),
	});

	describe("resolve", () => {
		it("resolves a simple model name", () => {
			providers.set("openai-compat", fakeProvider("openai-compat"));
			const result = store.resolve("opencode/deepseek-v4-flash");
			expect(result).toEqual({ providerId: "openai-compat", model: "deepseek-v4-flash" });
		});

		it("resolves a model name with slashes", () => {
			const result = store.resolve("opencode/a/b");
			expect(result).toEqual({ providerId: "openai-compat", model: "a/b" });
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
			const result = store.resolve("opencode/");
			expect(result).toBeUndefined();
		});
	});

	describe("listCatalog", () => {
		it("lists models from providers with listModels", async () => {
			providers.set(
				"openai-compat",
				fakeProvider("openai-compat", async () => [{ id: "m1" }, { id: "m2" }]),
			);

			const catalog = await store.listCatalog();
			expect(catalog).toEqual(["opencode/m1", "opencode/m2"]);
		});

		it("skips credentials whose provider has no listModels", async () => {
			providers.set("openai-compat", fakeProvider("openai-compat"));

			const catalog = await store.listCatalog();
			expect(catalog).toEqual([]);
		});

		it("skips credentials whose provider is missing", async () => {
			const emptyStore = createCredentialStore({
				credentials: [{ name: "missing", providerId: "nonexistent" }],
				getProvider: () => undefined,
			});

			const catalog = await emptyStore.listCatalog();
			expect(catalog).toEqual([]);
		});
	});
});
