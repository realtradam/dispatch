import type { ConversationStore } from "@dispatch/conversation-store";
import type {
	AgentEvent,
	ChatMessage,
	EventHookDescriptor,
	Logger,
	ProviderContract,
	ProviderEvent,
	ProviderStreamOptions,
	ReasoningEffort,
	RunTurnInput,
	RunTurnResult,
	ToolContract,
	ToolDispatchPolicy,
	UsageEvent,
} from "@dispatch/kernel";
import { defineEventHook, defineService, type ServiceHandle } from "@dispatch/kernel";
import { createMetricsAccumulator } from "./metrics.js";
import {
	buildUserMessage,
	defaultDispatchPolicy,
	generateTurnId,
	resolveReasoningEffort,
} from "./pure.js";
import type { ToolAssembly } from "./tools-filter.js";

// --- Broadcast hub types ---

export interface StartTurnInput {
	readonly conversationId: string;
	readonly text: string;
	readonly modelName?: string;
	readonly cwd?: string;
	readonly reasoningEffort?: ReasoningEffort;
}

export type StartTurnResult =
	| { readonly started: true; readonly turnId: string }
	| { readonly started: false; readonly reason: "already-active" };

export type TurnEventListener = (event: AgentEvent) => void;

interface ActiveTurn {
	buffer: AgentEvent[];
	turnId: string;
	/** Aborts this turn's kernel runTurn (closeConversation). */
	controller: AbortController;
}

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

/** Payload for the conversationClosed bus event. */
export interface ConversationClosedPayload {
	readonly conversationId: string;
}

/**
 * Fired when a client EXPLICITLY closes a conversation (tab close — NOT a mere
 * disconnect). Consumers stop per-conversation background work (e.g. cache-warming
 * disables its schedule). Emitted by `SessionOrchestrator.closeConversation`.
 */
export const conversationClosed: EventHookDescriptor<ConversationClosedPayload> =
	defineEventHook<ConversationClosedPayload>("session-orchestrator/conversation-closed");

/** Payload for the warmCompleted bus event. */
export interface WarmCompletedPayload {
	readonly conversationId: string;
	readonly usage: WarmResult;
}

/** Fired when a warm probe succeeds (both automatic and manual paths). */
export const warmCompleted: EventHookDescriptor<WarmCompletedPayload> =
	defineEventHook<WarmCompletedPayload>("session-orchestrator/warm-completed");

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
	startTurn(input: StartTurnInput): StartTurnResult;
	subscribe(conversationId: string, listener: TurnEventListener): () => void;
	isActive(conversationId: string): boolean;
	/**
	 * Explicitly close a conversation (the user closed its tab — distinct from a
	 * socket disconnect, which never touches the turn): aborts any in-flight turn
	 * (the kernel finishes with `finishReason: "aborted"`, partial messages are
	 * persisted and the turn seals normally) and emits the `conversationClosed`
	 * hook so per-conversation background work (cache-warming) stops.
	 * Idempotent — closing an idle/unknown conversation just emits the hook.
	 */
	closeConversation(conversationId: string): { readonly abortedTurn: boolean };
	handleMessage(input: {
		conversationId: string;
		text: string;
		onEvent: (event: AgentEvent) => void;
		modelName?: string;
		cwd?: string;
		reasoningEffort?: ReasoningEffort;
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

/** Deps for the warm service — emit is REQUIRED so warmCompleted is never silently dropped. */
export type WarmServiceDeps = SessionOrchestratorDeps & {
	readonly emit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;
};

export interface SessionOrchestratorBundle {
	readonly orchestrator: SessionOrchestrator;
	/** The shared active-conversations set, for use by createWarmService. */
	readonly activeConversations: ReadonlySet<string>;
}

export function createSessionOrchestrator(
	deps: SessionOrchestratorDeps,
): SessionOrchestratorBundle {
	const activeConversations = new Set<string>();
	const subscribers = new Map<string, Set<TurnEventListener>>();
	const activeTurns = new Map<string, ActiveTurn>();

	function emitToHub(conversationId: string, event: AgentEvent): void {
		const turn = activeTurns.get(conversationId);
		if (turn !== undefined) {
			turn.buffer.push(event);
		}
		const listeners = subscribers.get(conversationId);
		if (listeners !== undefined) {
			for (const listener of listeners) {
				listener(event);
			}
		}
	}

	function runTurnDetached(
		conversationId: string,
		text: string,
		modelName: string | undefined,
		cwd: string | undefined,
		reasoningEffortOverride: ReasoningEffort | undefined,
	): void {
		const turnId = generateTurnId();
		const controller = new AbortController();
		activeTurns.set(conversationId, { buffer: [], turnId, controller });
		activeConversations.add(conversationId);

		emitToHub(conversationId, { type: "user-message", conversationId, turnId, text });

		const effectiveCwdPromise =
			cwd !== undefined
				? Promise.resolve(cwd)
				: deps.conversationStore.getCwd(conversationId).then((c) => c ?? undefined);

		const storedEffortPromise = deps.conversationStore.getReasoningEffort(conversationId);

		const payloadPromise = Promise.all([effectiveCwdPromise, storedEffortPromise]).then(
			([effectiveCwd]) => ({
				conversationId,
				...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
				...(modelName !== undefined ? { modelName } : {}),
			}),
		);

		payloadPromise.then((payload) => {
			deps.emit?.(turnStarted, payload);
		});

		void (async () => {
			try {
				const [effectiveCwd, storedEffort] = await Promise.all([
					effectiveCwdPromise,
					storedEffortPromise,
				]);

				if (cwd !== undefined) {
					await deps.conversationStore.setCwd(conversationId, cwd);
				}

				const resolvedEffort = resolveReasoningEffort(reasoningEffortOverride, storedEffort);

				const history = await deps.conversationStore.load(conversationId);
				const userMsg = buildUserMessage(text);

				let provider: ProviderContract;
				let modelOverride: string | undefined;

				if (modelName !== undefined && deps.resolveModel !== undefined) {
					const resolved = deps.resolveModel(modelName);
					if (resolved === undefined) {
						emitToHub(conversationId, {
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
					...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
				});
				const dispatch = deps.resolveDispatch?.() ?? defaultDispatchPolicy();
				const turnLogger = deps.logger?.child({ conversationId, turnId });
				const metrics = createMetricsAccumulator();

				const emitAndAccumulate = (event: AgentEvent): void => {
					metrics.ingest(event);
					emitToHub(conversationId, event);
				};

				const providerOpts: ProviderStreamOptions = {
					reasoningEffort: resolvedEffort,
					...(modelOverride !== undefined ? { model: modelOverride } : {}),
				};

				const opts: RunTurnInput = {
					provider,
					messages: [...history, userMsg],
					tools: assembled.tools,
					dispatch,
					emit: emitAndAccumulate,
					conversationId,
					turnId,
					signal: controller.signal,
					providerOpts,
					...(turnLogger !== undefined ? { logger: turnLogger } : {}),
					...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
					...(deps.now !== undefined ? { now: deps.now } : {}),
				};

				const result = await deps.runTurn(opts);

				const toPersist: ChatMessage[] = [userMsg, ...result.messages];
				await deps.conversationStore.append(conversationId, toPersist);

				const turnMetrics = metrics.build(turnId);
				await deps.conversationStore.appendMetrics(conversationId, turnMetrics);

				emitToHub(conversationId, { type: "turn-sealed", conversationId, turnId });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				emitToHub(conversationId, {
					type: "error",
					conversationId,
					turnId,
					message,
				});
			} finally {
				activeTurns.delete(conversationId);
				activeConversations.delete(conversationId);
				void payloadPromise.then((payload) => {
					deps.emit?.(turnSettled, payload);
				});
			}
		})();
	}

	const orchestrator: SessionOrchestrator = {
		startTurn({ conversationId, text, modelName, cwd, reasoningEffort }) {
			if (activeTurns.has(conversationId)) {
				return { started: false, reason: "already-active" };
			}
			runTurnDetached(conversationId, text, modelName, cwd, reasoningEffort);
			const turn = activeTurns.get(conversationId);
			const turnId = turn !== undefined ? turn.turnId : "";
			return { started: true, turnId };
		},

		subscribe(conversationId, listener) {
			let listeners = subscribers.get(conversationId);
			if (listeners === undefined) {
				listeners = new Set();
				subscribers.set(conversationId, listeners);
			}
			const turn = activeTurns.get(conversationId);
			if (turn !== undefined) {
				const snapshot = [...turn.buffer];
				listeners.add(listener);
				for (const event of snapshot) {
					listener(event);
				}
			} else {
				listeners.add(listener);
			}
			return () => {
				const set = subscribers.get(conversationId);
				if (set !== undefined) {
					set.delete(listener);
					if (set.size === 0) {
						subscribers.delete(conversationId);
					}
				}
			};
		},

		isActive(conversationId) {
			return activeTurns.has(conversationId);
		},

		closeConversation(conversationId) {
			const turn = activeTurns.get(conversationId);
			const abortedTurn = turn !== undefined;
			if (turn !== undefined) {
				turn.controller.abort();
			}
			deps.emit?.(conversationClosed, { conversationId });
			return { abortedTurn };
		},

		async handleMessage({ conversationId, text, onEvent, modelName, cwd, reasoningEffort }) {
			const turnInput: StartTurnInput = {
				conversationId,
				text,
				...(modelName !== undefined ? { modelName } : {}),
				...(cwd !== undefined ? { cwd } : {}),
				...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
			};
			const result = orchestrator.startTurn(turnInput);
			if (!result.started) {
				const errorTurnId = generateTurnId();
				onEvent({
					type: "error",
					conversationId,
					turnId: errorTurnId,
					message: "turn already active for this conversation",
				});
				return;
			}

			await new Promise<void>((resolve) => {
				const unsubscribe = orchestrator.subscribe(conversationId, (event) => {
					onEvent(event);
					if (event.type === "turn-sealed" || event.type === "error") {
						unsubscribe();
						resolve();
					}
				});
			});
		},
	};

	return { orchestrator, activeConversations };
}

export function createWarmService(
	deps: WarmServiceDeps,
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
			// Resolve cwd the SAME way handleMessage does (caller value → stored cwd).
			// The tools filter is cwd-sensitive (e.g. skill discovery rewrites the
			// `load_skill` description per-cwd). If the warm assembles tools under a
			// different cwd than the real turn, the tools block — the FIRST bytes of
			// the prompt-cache prefix — diverges and the cache misses entirely (0%).
			// A manual reheat sends no cwd, so without this fallback it would warm the
			// wrong prefix. See notes/observability-design.md §3.1.
			const cwd = opts?.cwd ?? (await deps.conversationStore.getCwd(conversationId)) ?? undefined;
			const assembled = await deps.applyToolsFilter({
				tools: baseTools,
				conversationId,
				...(cwd !== undefined ? { cwd } : {}),
			});

			// Resolve reasoning effort the SAME way the real turn does (stored → "high";
			// no per-turn override on warm). A mismatch here silently busts the prompt cache.
			const storedEffort = await deps.conversationStore.getReasoningEffort(conversationId);
			const resolvedEffort = resolveReasoningEffort(undefined, storedEffort);

			const probeMsg: ChatMessage = {
				role: "user",
				chunks: [{ type: "text", text: "reply with just a ." }],
			};
			const messages = [...history, probeMsg];

			// Capture the warm send as a `provider.request` span, flagged `warm: true`
			// so it can be diffed against the corresponding real turn's request (the
			// prompt-cache 0%-hit debugging workflow — see notes/observability-design.md
			// §3.1). Without this the warm body is invisible and the cache bust is
			// undebuggable. The child-bound `warm` attribute flows into the span the
			// provider opens (kernel logger merges child attrs into span attributes).
			const warmLogger = deps.logger?.child({ conversationId, attrs: { warm: true } });
			const providerOpts: ProviderStreamOptions = {
				maxTokens: 1,
				reasoningEffort: resolvedEffort,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
				...(warmLogger !== undefined ? { logger: warmLogger } : {}),
			};

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

			const result: WarmResult = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
			deps.emit(warmCompleted, { conversationId, usage: result });
			return result;
		},
	};
}
