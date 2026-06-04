import type { ConversationStore } from "@dispatch/conversation-store";
import type {
	AgentEvent,
	ChatMessage,
	ProviderContract,
	RunTurnInput,
	RunTurnResult,
	ToolContract,
	ToolDispatchPolicy,
} from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import { buildUserMessage, defaultDispatchPolicy, generateTurnId } from "./pure.js";

export interface SessionOrchestrator {
	handleMessage(input: {
		conversationId: string;
		text: string;
		onEvent: (event: AgentEvent) => void;
		signal?: AbortSignal;
	}): Promise<void>;
}

export const sessionOrchestratorHandle = defineService<SessionOrchestrator>(
	"session-orchestrator/orchestrator",
);

export interface SessionOrchestratorDeps {
	readonly conversationStore: ConversationStore;
	readonly resolveProvider: () => ProviderContract;
	readonly resolveTools: () => readonly ToolContract[];
	readonly resolveDispatch?: () => ToolDispatchPolicy;
	readonly runTurn: (input: RunTurnInput) => Promise<RunTurnResult>;
}

export function createSessionOrchestrator(deps: SessionOrchestratorDeps): SessionOrchestrator {
	return {
		async handleMessage({ conversationId, text, onEvent, signal }) {
			const history = await deps.conversationStore.load(conversationId);
			const userMsg = buildUserMessage(text);
			const provider = deps.resolveProvider();
			const tools = deps.resolveTools();
			const dispatch = deps.resolveDispatch?.() ?? defaultDispatchPolicy();
			const turnId = generateTurnId();

			const result = await deps.runTurn({
				provider,
				messages: [...history, userMsg],
				tools,
				dispatch,
				emit: onEvent,
				conversationId,
				turnId,
				...(signal !== undefined ? { signal } : {}),
			});

			const toPersist: ChatMessage[] = [userMsg, ...result.messages];
			await deps.conversationStore.append(conversationId, toPersist);
		},
	};
}
