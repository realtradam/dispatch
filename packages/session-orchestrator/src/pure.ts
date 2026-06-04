import type { ChatMessage, ProviderContract, ToolDispatchPolicy } from "@dispatch/kernel";

export function buildUserMessage(text: string): ChatMessage {
	return { role: "user", chunks: [{ type: "text", text }] };
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
