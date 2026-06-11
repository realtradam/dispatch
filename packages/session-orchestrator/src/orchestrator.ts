import type { ConversationStore } from "@dispatch/conversation-store";
import type {
	AgentEvent,
	ChatMessage,
	EventHookDescriptor,
	Logger,
	ProviderContract,
	ProviderEvent,
	ProviderStreamOptions,
	RunTurnInput,
	RunTurnResult,
	ToolContract,
	ToolDispatchPolicy,
	UsageEvent,
} from "@dispatch/kernel";
import { defineEventHook, defineService, type ServiceHandle } from "@dispatch/kernel";
import { createMetricsAccumulator } from "./metrics.js";
import { buildUserMessage, defaultDispatchPolicy, generateTurnId } from "./pure.js";
import type { ToolAssembly } from "./tools-filter.js";

// --- Lifecycle event hooks ---

/** Context carried on turn-lifecycle events, enough to replicate the turn's request prefix. */
export interface TurnLifecyclePayload {
	readonly conversationId: string;
	readonly cwd?: string;
	readonly modelName?: string;
}

/** Fired when a turn STARTS driving a conversation (consumers cancel warming timers). */
export const turnStarted: EventHookDescriptor<TurnLifecyclePayload> =
	defineEventHook<TurnLifecyclePayload>("session-orchestrator/turn-started");

/** Fired when a turn SETTLES (sealed) for a conversation (consumers arm warming timers). */
export const turnSettled: EventHookDescriptor<TurnLifecyclePayload> =
	defineEventHook<TurnLifecyclePayload>("session-orchestrator/turn-settled");

// --- Warm service ---

export interface WarmResult {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
}

export interface WarmService {
	readonly warm: (
		conversationId: string,
		opts?: { readonly cwd?: string; readonly modelName?: string },
	) => Promise<WarmResult | { readonly error: string }>;
}

export const cacheWarmHandle: ServiceHandle<WarmService> = defineService<WarmService>(
	"session-orchestrator/warm",
);

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
	/** Apply the per-turn tools filter chain. Injected for testability. */
	readonly applyToolsFilter: (assembly: ToolAssembly) => Promise<ToolAssembly>;
	/** Base logger (auto-scoped to this extension); childed per turn for span capture. */
	readonly logger?: Logger;
	/** Injected monotonic-ish clock (ms) forwarded to RunTurnInput for timing events. */
	readonly now?: () => number;
	/** Emit a lifecycle event hook to subscribers. Injected from host. */
	readonly emit?: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;
}

export interface SessionOrchestratorBundle {
	readonly orchestrator: SessionOrchestrator;
	/** The shared active-conversations set, for use by createWarmService. */
	readonly activeConversations: ReadonlySet<string>;
}

export function createSessionOrchestrator(
	deps: SessionOrchestratorDeps,
): SessionOrchestratorBundle {
	const activeConversations = new Set<string>();

	const orchestrator: SessionOrchestrator = {
		async handleMessage({ conversationId, text, onEvent, signal, modelName, cwd }) {
			const payload: TurnLifecyclePayload = {
				conversationId,
				...(cwd !== undefined ? { cwd } : {}),
				...(modelName !== undefined ? { modelName } : {}),
			};
			deps.emit?.(turnStarted, payload);
			activeConversations.add(conversationId);

			try {
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

				const baseTools = deps.resolveTools();
				const assembled = await deps.applyToolsFilter({
					tools: baseTools,
					conversationId,
					...(cwd !== undefined ? { cwd } : {}),
				});
				const dispatch = deps.resolveDispatch?.() ?? defaultDispatchPolicy();
				const turnLogger = deps.logger?.child({ conversationId, turnId });
				const metrics = createMetricsAccumulator();

				const emitAndAccumulate = (event: AgentEvent): void => {
					metrics.ingest(event);
					onEvent(event);
				};

				const opts: RunTurnInput = {
					provider,
					messages: [...history, userMsg],
					tools: assembled.tools,
					dispatch,
					emit: emitAndAccumulate,
					conversationId,
					turnId,
					...(modelOverride !== undefined
						? { providerOpts: { model: modelOverride } satisfies ProviderStreamOptions }
						: {}),
					...(turnLogger !== undefined ? { logger: turnLogger } : {}),
					...(signal !== undefined ? { signal } : {}),
					...(cwd !== undefined ? { cwd } : {}),
					...(deps.now !== undefined ? { now: deps.now } : {}),
				};

				const result = await deps.runTurn(opts);

				const toPersist: ChatMessage[] = [userMsg, ...result.messages];
				await deps.conversationStore.append(conversationId, toPersist);

				const turnMetrics = metrics.build(turnId);
				await deps.conversationStore.appendMetrics(conversationId, turnMetrics);

				onEvent({ type: "turn-sealed", conversationId, turnId });
			} finally {
				activeConversations.delete(conversationId);
				deps.emit?.(turnSettled, payload);
			}
		},
	};

	return { orchestrator, activeConversations };
}

export function createWarmService(
	deps: SessionOrchestratorDeps,
	activeConversations: ReadonlySet<string>,
): WarmService {
	return {
		async warm(conversationId, opts) {
			if (activeConversations.has(conversationId)) {
				return { error: "conversation is generating" };
			}

			const history = await deps.conversationStore.load(conversationId);
			if (history.length === 0) {
				return { error: "no history" };
			}

			let provider: ProviderContract;
			let modelOverride: string | undefined;

			if (opts?.modelName !== undefined && deps.resolveModel !== undefined) {
				const resolved = deps.resolveModel(opts.modelName);
				if (resolved === undefined) {
					return { error: `unknown model: ${opts.modelName}` };
				}
				provider = resolved.provider;
				modelOverride = resolved.model;
			} else {
				provider = deps.resolveProvider();
			}

			const baseTools = deps.resolveTools();
			const cwd = opts?.cwd;
			const assembled = await deps.applyToolsFilter({
				tools: baseTools,
				conversationId,
				...(cwd !== undefined ? { cwd } : {}),
			});

			const probeMsg: ChatMessage = {
				role: "user",
				chunks: [{ type: "text", text: "reply with just a ." }],
			};
			const messages = [...history, probeMsg];

			const providerOpts: ProviderStreamOptions | undefined =
				modelOverride !== undefined ? { model: modelOverride, maxTokens: 1 } : { maxTokens: 1 };

			let inputTokens = 0;
			let outputTokens = 0;
			let cacheReadTokens = 0;
			let cacheWriteTokens = 0;

			for await (const event of provider.stream(messages, assembled.tools, providerOpts)) {
				if ((event as ProviderEvent).type === "usage") {
					const usageEvent = event as UsageEvent;
					inputTokens = usageEvent.usage.inputTokens;
					outputTokens = usageEvent.usage.outputTokens;
					cacheReadTokens = usageEvent.usage.cacheReadTokens ?? 0;
					cacheWriteTokens = usageEvent.usage.cacheWriteTokens ?? 0;
				}
			}

			return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
		},
	};
}
