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
