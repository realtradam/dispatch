export { getVariableCatalog } from "./catalog.js";
export { extension, manifest } from "./extension.js";
export { extractVariables, parseTemplate } from "./parser.js";
export type {
	GitSpawn,
	GitSpawnResult,
	ResolveOptions,
	ResolverAdapters,
	ResolverContext,
	ResolverFs,
} from "./resolver.js";
export { resolveVariables } from "./resolver.js";
export type { SystemPromptServiceDeps } from "./service.js";
export { createSystemPromptService, DEFAULT_TEMPLATE } from "./service.js";
export type { SystemPromptService } from "./types.js";
export { systemPromptHandle } from "./types.js";
