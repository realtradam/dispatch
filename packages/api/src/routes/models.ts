import { Hono } from "hono";
import type { ModelRegistry, ModelResolver } from "@dispatch/core";

let getRegistry: () => ModelRegistry | null = () => null;
let getResolver: () => ModelResolver | null = () => null;

export function setModelsGetter(
	registryGetter: () => ModelRegistry | null,
	resolverGetter: () => ModelResolver | null,
): void {
	getRegistry = registryGetter;
	getResolver = resolverGetter;
}

export const modelsRoutes = new Hono();

modelsRoutes.get("/", (c) => {
	const registry = getRegistry();
	if (!registry) {
		return c.json({ models: [], tags: [], keys: [] });
	}

	const models = registry.getModels();
	const tags = registry.getAllTags();
	const keyStates = registry.getKeys();

	const keys = keyStates.map((ks) => ({
		id: ks.definition.id,
		provider: ks.definition.provider,
		status: ks.status,
		lastError: ks.lastError ?? null,
		exhaustedAt: ks.exhaustedAt ?? null,
	}));

	return c.json({ models, tags, keys });
});

modelsRoutes.get("/resolve", (c) => {
	const registry = getRegistry();
	const resolver = getResolver();
	if (!registry || !resolver) {
		return c.json({ resolved: null, reason: "no models configured" });
	}

	const tag = c.req.query("tag");
	if (!tag) {
		return c.json({ error: "tag query parameter is required" }, 400);
	}

	const matchingModels = registry.getModelsByTag(tag);
	if (matchingModels.length === 0) {
		return c.json({ resolved: null, reason: "no models match tag" });
	}

	const resolved = resolver.resolve(tag);
	if (!resolved) {
		return c.json({ resolved: null, reason: "all keys exhausted for matching providers" });
	}

	return c.json({
		resolved: {
			model: resolved.model,
			key: {
				id: resolved.key.id,
				provider: resolved.key.provider,
			},
		},
	});
});
