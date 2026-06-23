/**
 * System-prompt service handle + interface.
 *
 * The service is the single-responder anchor the session-orchestrator obtains
 * (lazily, via `host.getService(systemPromptHandle)`) to construct and read the
 * per-conversation resolved system prompt.
 */
import { defineService, type ServiceHandle } from "@dispatch/kernel";

/**
 * The system-prompt service.
 *
 * `construct` resolves the template once (first turn / compaction) and persists
 * the result; `get` reads the persisted result on subsequent turns (cache-safe —
 * no per-turn reconstruction).
 */
export interface SystemPromptService {
	/**
	 * Resolve the template against the current environment and persist the
	 * result under `resolved:<conversationId>`. Returns the resolved string.
	 * When no template is stored, the built-in default template is used. An
	 * empty template yields an empty string.
	 */
	construct(
		conversationId: string,
		cwd: string,
		context?: { readonly model?: string },
	): Promise<string>;

	/** Read the persisted resolved system prompt, or `null` if never constructed. */
	get(conversationId: string): Promise<string | null>;
}

/**
 * Typed handle anchoring the system-prompt service. The single symbol the
 * session-orchestrator imports to reach the builder — no string-keyed lookup.
 */
export const systemPromptHandle: ServiceHandle<SystemPromptService> =
	defineService<SystemPromptService>("system-prompt");
