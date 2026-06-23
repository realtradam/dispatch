import type {
	ChatMessage,
	ProviderContract,
	ReasoningEffort,
	ToolDispatchPolicy,
} from "@dispatch/kernel";

export function buildUserMessage(text: string): ChatMessage {
	return { role: "user", chunks: [{ type: "text", text }] };
}

/**
 * Resolve the reasoning-effort level for a turn:
 *   per-turn override → persisted per-conversation value → default `"high"`.
 * Pure — no I/O, no ambient state.
 */
export function resolveReasoningEffort(
	override: ReasoningEffort | undefined,
	stored: ReasoningEffort | null,
): ReasoningEffort {
	return override ?? stored ?? "high";
}

/**
 * Resolve the model name for a turn:
 *   per-turn override → persisted per-conversation value → `undefined`.
 *
 * Unlike {@link resolveReasoningEffort}, there is NO default model name: when
 * both the override and the persisted value are absent, this returns
 * `undefined` and the caller falls through to `resolveProvider()` (the default
 * provider). Returning `undefined` (rather than a sentinel) keeps the existing
 * "no model override" code path untouched. Pure — no I/O, no ambient state.
 */
export function resolveModelName(
	override: string | undefined,
	stored: string | null,
): string | undefined {
	return override ?? stored ?? undefined;
}

export function selectFirstProvider(
	providers: ReadonlyMap<string, ProviderContract>,
): ProviderContract {
	const first = providers.values().next();
	if (first.done === true || first.value === undefined) {
		throw new Error("No providers registered — at least one provider is required to run a turn.");
	}
	return first.value;
}

export function resolveTools(tools: ReadonlyMap<string, unknown>): readonly unknown[] {
	return [...tools.values()];
}

export function defaultDispatchPolicy(): ToolDispatchPolicy {
	return { maxConcurrent: 1, eager: true };
}

export function generateTurnId(): string {
	return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
