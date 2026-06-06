import type { ConversationStore } from "@dispatch/conversation-store";
import type {
	AgentEvent,
	ChatMessage,
	Logger,
	ProviderContract,
	ProviderStreamOptions,
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
		modelName?: string;
		cwd?: string;
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
	readonly resolveModel?: (
		modelName: string,
	) => { provider: ProviderContract; model: string } | undefined;
	readonly runTurn: (input: RunTurnInput) => Promise<RunTurnResult>;
	/** Base logger (auto-scoped to this extension); childed per turn for span capture. */
	readonly logger?: Logger;
}

export function createSessionOrchestrator(deps: SessionOrchestratorDeps): SessionOrchestrator {
	return {
		async handleMessage({ conversationId, text, onEvent, signal, modelName, cwd }) {
			const history = await deps.conversationStore.load(conversationId);
			const userMsg = buildUserMessage(text);
			const turnId = generateTurnId();

			let provider: ProviderContract;
			let modelOverride: string | undefined;

			if (modelName !== undefined && deps.resolveModel !== undefined) {
				const resolved = deps.resolveModel(modelName);
				if (resolved === undefined) {
					onEvent({
						type: "error",
						conversationId,
						turnId,
						message: `unknown model: ${modelName}`,
					});
					return;
				}
				provider = resolved.provider;
				modelOverride = resolved.model;
			} else {
				provider = deps.resolveProvider();
			}

			const tools = deps.resolveTools();
			const dispatch = deps.resolveDispatch?.() ?? defaultDispatchPolicy();
			const turnLogger = deps.logger?.child({ conversationId, turnId });

			const opts: RunTurnInput = {
				provider,
				messages: [...history, userMsg],
				tools,
				dispatch,
				emit: onEvent,
				conversationId,
				turnId,
				...(modelOverride !== undefined
					? { providerOpts: { model: modelOverride } satisfies ProviderStreamOptions }
					: {}),
				...(turnLogger !== undefined ? { logger: turnLogger } : {}),
				...(signal !== undefined ? { signal } : {}),
				...(cwd !== undefined ? { cwd } : {}),
			};

			const result = await deps.runTurn(opts);

			const toPersist: ChatMessage[] = [userMsg, ...result.messages];
			await deps.conversationStore.append(conversationId, toPersist);

			onEvent({ type: "turn-sealed", conversationId, turnId });
		},
	};
}
