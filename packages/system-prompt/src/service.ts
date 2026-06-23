/**
 * System-prompt service factory — owns the construct/get decision logic.
 *
 * Pure-ish: takes a storage namespace + resolver adapters as deps (both
 * injectable), so the service is testable with an in-memory storage and fake
 * adapters. The real Bun-backed adapters are wired in `extension.ts`.
 */
import type { StorageNamespace } from "@dispatch/kernel";
import { extractVariables, parseTemplate } from "./parser.js";
import type { ResolverAdapters, ResolverContext } from "./resolver.js";
import { resolveVariables } from "./resolver.js";
import type { SystemPromptService } from "./types.js";

/**
 * The default template used when no template has been stored. Embeds the
 * working directory and an optional `AGENTS.md` (only when the file exists).
 */
export const DEFAULT_TEMPLATE = `You are a helpful coding assistant.

[if file:AGENTS.md]
[file:AGENTS.md]
[endif]

The current working directory is [prompt:cwd].
`;

/** Storage keys. */
const TEMPLATE_KEY = "template";
const resolvedKey = (conversationId: string): string => `resolved:${conversationId}`;

export interface SystemPromptServiceDeps {
	/** Namespaced KV (`host.storage("system-prompt")`). */
	readonly storage: StorageNamespace;
	/** Injected effects for variable resolution. */
	readonly adapters: ResolverAdapters;
}

/**
 * Create a `SystemPromptService` backed by a storage namespace + adapters.
 * State is owned (not ambient): the storage reference lives in this closure.
 */
export function createSystemPromptService(deps: SystemPromptServiceDeps): SystemPromptService {
	return {
		async construct(conversationId, cwd, context) {
			let template = await deps.storage.get(TEMPLATE_KEY);
			if (template === null) template = DEFAULT_TEMPLATE;

			const referencedKeys = extractVariables(template);
			const resolverContext: ResolverContext =
				context?.model !== undefined
					? { model: context.model, conversationId }
					: { conversationId };
			const vars = await resolveVariables(cwd, deps.adapters, {
				context: resolverContext,
				referencedKeys,
			});
			const result = parseTemplate(template, vars);

			await deps.storage.set(resolvedKey(conversationId), result);
			return result;
		},

		async get(conversationId) {
			return deps.storage.get(resolvedKey(conversationId));
		},
	};
}
