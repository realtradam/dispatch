import type { ConversationStore } from "@dispatch/conversation-store";
import type {
	AgentEvent,
	ChatMessage,
	CompactionResult,
	ConversationStatus,
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
import type { MessageQueueService, QueuedMessage } from "@dispatch/message-queue";
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

/** Input to `SessionOrchestrator.enqueue` — the single entry transports call. */
export interface EnqueueInput {
	readonly conversationId: string;
	readonly text: string;
}

/**
 * Result of `SessionOrchestrator.enqueue`. When `startedTurn` is true the
 * conversation was idle and a turn was started (the message is the opening
 * prompt — nothing queued). When false the conversation was active: the message
 * was enqueued onto the steering queue and `queue` is the post-enqueue snapshot
 * (empty when the message-queue extension isn't loaded — degraded: the message
 * is dropped, see `enqueue` docs).
 */
export interface EnqueueResult {
	readonly startedTurn: boolean;
	readonly queue: readonly QueuedMessage[];
}

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

/** Payload for the conversationOpened bus event. */
export interface ConversationOpenedPayload {
	readonly conversationId: string;
}

/**
 * Fired when a client requests to "open" a conversation (e.g. the CLI `--open`
 * flag). Transport-ws subscribes and broadcasts a `conversation.open` WS
 * message to all connected frontend clients. The frontend decides whether to
 * open/focus a tab — the backend just signals.
 */
export const conversationOpened: EventHookDescriptor<ConversationOpenedPayload> =
	defineEventHook<ConversationOpenedPayload>("session-orchestrator/conversation-opened");

/** Payload for the conversationStatusChanged bus event. */
export interface ConversationStatusChangedPayload {
	readonly conversationId: string;
	readonly status: ConversationStatus;
}

/**
 * Fired when a conversation's lifecycle status changes (active/idle/closed).
 * Transport-ws subscribes and broadcasts a `conversation.statusChanged` WS
 * message to all connected frontend clients so tabs sync across devices.
 */
export const conversationStatusChanged: EventHookDescriptor<ConversationStatusChangedPayload> =
	defineEventHook<ConversationStatusChangedPayload>(
		"session-orchestrator/conversation-status-changed",
	);

/** Payload for the conversationCompacted bus event. */
export interface ConversationCompactedPayload {
	readonly conversationId: string;
	readonly newConversationId: string;
	readonly messagesSummarized: number;
	readonly messagesKept: number;
}

/**
 * Fired when a conversation's history has been compacted (old messages
 * summarized, recent messages retained). Transport-ws subscribes and
 * broadcasts a `conversation.compacted` WS message so the FE reloads history.
 */
export const conversationCompacted: EventHookDescriptor<ConversationCompactedPayload> =
	defineEventHook<ConversationCompactedPayload>("session-orchestrator/conversation-compacted");

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

// --- Compaction service ---

export interface CompactionService {
	/**
	 * Compact a conversation: summarize old messages and replace history with
	 * the summary + the most recent `keepLastN` messages. Returns the result
	 * or an error object. No-ops if the conversation is too short (≤ keepLastN
	 * messages). When `auto` is true, checks the compact-threshold setting and
	 * only compacts if the last turn's input tokens exceeded it.
	 */
	readonly compact: (
		conversationId: string,
		opts?: { readonly keepLastN?: number; readonly modelName?: string; readonly auto?: boolean },
	) => Promise<CompactionResult | { readonly error: string }>;
}

export const compactionHandle: ServiceHandle<CompactionService> = defineService<CompactionService>(
	"session-orchestrator/compaction",
);

export interface SessionOrchestrator {
	startTurn(input: StartTurnInput): StartTurnResult;
	/**
	 * The single entry transports call to deliver a user message. Owns the
	 * idle→startTurn vs active→queue decision (no separate `isActive` race —
	 * `startTurn`'s single-flight guard is authoritative). When the conversation
	 * is idle, starts a turn (the message is the opening prompt). When active,
	 * enqueues onto the steering queue (if the message-queue extension is
	 * loaded); with no queue extension loaded the message is dropped and the
	 * returned snapshot is empty (degraded — feature off).
	 */
	enqueue(input: EnqueueInput): EnqueueResult;
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
	/**
	 * Lazily resolves the message-queue service (the steering queue), or
	 * `undefined` when the message-queue extension isn't loaded (the feature
	 * degrades off: no `drainSteering`, no post-seal carry, `enqueue` drops
	 * messages when active). host-bin wires this via `host.getService`; the
	 * orchestrator calls it per-turn / per-enqueue so activation order with the
	 * message-queue extension doesn't matter. Injected (not ambient) so a turn
	 * stays reproducible from its inputs and tests use a fake queue.
	 */
	readonly resolveQueue?: () => MessageQueueService | undefined;
	/**
	 * Lazily resolves the compaction service, or `undefined` when not loaded.
	 * Used for automatic compaction after a turn settles (if the compact
	 * threshold is exceeded). Lazy so activation order doesn't matter.
	 */
	readonly resolveCompaction?: () => CompactionService | undefined;
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

	/**
	 * Post-seal carry: if a steering queue is available and non-empty, drain it,
	 * combine, and start a NEW detached turn whose opening `user-message` carries
	 * the combined text (no `steering` event — that's only for mid-turn drain).
	 * Returns true iff a new turn was started. Called from `runTurnDetached`'s
	 * finally AFTER `activeTurns.delete` (so the new turn's single-flight guard
	 * passes) and BEFORE `activeConversations.delete` (skipped when carried, since
	 * the new turn re-adds it). May chain — the new turn's own finally re-checks.
	 */
	function tryCarryQueue(conversationId: string): boolean {
		const queue = deps.resolveQueue?.();
		if (queue === undefined) return false;
		if (queue.getQueue(conversationId).length === 0) return false;
		const drained = queue.drain(conversationId);
		const combined = drained.map((q) => q.text).join("\n\n");
		const result = orchestrator.startTurn({ conversationId, text: combined });
		return result.started;
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
			deps.emit?.(conversationStatusChanged, { conversationId, status: "active" });
			void deps.conversationStore.setConversationStatus(conversationId, "active");
		});

		void (async () => {
			let sealed = false;
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

				// Resolve the steering queue once for this turn. When present, wire
				// `drainSteering`: the kernel calls it at the tool-result boundary and
				// appends whatever it returns as user-role messages alongside the tool
				// results (mid-turn steering). The wrapper emits a `steering` AgentEvent
				// into the hub (buffered for late-join like `user-message`) so a
				// frontend can place a user bubble in the transcript live; the kernel
				// only appends the returned messages — it does NOT emit the event.
				const queue = deps.resolveQueue?.();
				const drainSteering =
					queue === undefined
						? undefined
						: (): readonly ChatMessage[] => {
								const queued = queue.drain(conversationId);
								if (queued.length === 0) return [];
								const steerText = queued.map((q) => q.text).join("\n\n");
								emitToHub(conversationId, {
									type: "steering",
									conversationId,
									turnId,
									text: steerText,
								});
								return [{ role: "user", chunks: [{ type: "text", text: steerText }] }];
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
					...(drainSteering !== undefined ? { drainSteering } : {}),
				};

				const result = await deps.runTurn(opts);

				const toPersist: ChatMessage[] = [userMsg, ...result.messages];
				await deps.conversationStore.append(conversationId, toPersist);

				const turnMetrics = metrics.build(turnId);
				await deps.conversationStore.appendMetrics(conversationId, turnMetrics);

				emitToHub(conversationId, { type: "turn-sealed", conversationId, turnId });
				sealed = true;
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
				// Post-seal carry: if the turn sealed with a non-empty steering queue
				// (no tool call fired → drainSteering never drained it), start a NEW
				// detached turn whose opening user-message carries the combined text.
				// The new turn re-adds to activeTurns + activeConversations, so skip
				// the activeConversations.delete when carried. May chain (user keeps
				// steering) — each carried turn's own finally re-checks the queue.
				const carried = sealed && tryCarryQueue(conversationId);
				if (!carried) {
					activeConversations.delete(conversationId);
				}
				void payloadPromise.then((payload) => {
					deps.emit?.(turnSettled, payload);
					if (!carried) {
						deps.emit?.(conversationStatusChanged, {
							conversationId,
							status: "idle",
						});
						void deps.conversationStore.setConversationStatus(conversationId, "idle");
						// Fire-and-forget auto-compaction: check threshold and
						// compact if exceeded. Non-blocking — the next turn
						// starts fresh either way.
						const compaction = deps.resolveCompaction?.();
						if (compaction !== undefined) {
							void compaction.compact(conversationId, { auto: true }).catch(() => {});
						}
					}
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

		enqueue({ conversationId, text }) {
			const result = orchestrator.startTurn({ conversationId, text });
			if (result.started) {
				return { startedTurn: true, queue: [] };
			}
			// Already active → enqueue onto the steering queue. When the
			// message-queue extension isn't loaded this degrades: the message is
			// dropped and the snapshot is empty (feature off).
			const queue = deps.resolveQueue?.();
			const snapshot = queue !== undefined ? queue.enqueue(conversationId, text) : [];
			return { startedTurn: false, queue: snapshot };
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
			deps.emit?.(conversationStatusChanged, { conversationId, status: "closed" });
			void deps.conversationStore.setConversationStatus(conversationId, "closed");
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

const DEFAULT_KEEP_LAST_N = 10;
const DEFAULT_COMPACT_THRESHOLD = 350000;

const COMPACTION_SYSTEM_PROMPT =
	"You are a conversation summarizer. Summarize the following conversation concord concisely but comprehensively. " +
	"Focus on key decisions, context, file paths, and any unresolved questions. " +
	"The summary must preserve enough detail for the conversation to continue with full context.";

function formatMessagesForSummary(messages: readonly ChatMessage[]): string {
	return messages
		.map((msg) => {
			const text = msg.chunks
				.map((c) => {
					if (c.type === "text") return c.text;
					if (c.type === "tool-call") return `[tool: ${c.toolName}]`;
					if (c.type === "tool-result") return `[tool result: ${c.content.slice(0, 200)}]`;
					return "";
				})
				.join("");
			return `${msg.role}: ${text}`;
		})
		.join("\n\n");
}

export function createCompactionService(
	deps: SessionOrchestratorDeps & {
		readonly emit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;
	},
	activeConversations: ReadonlySet<string>,
): CompactionService {
	return {
		async compact(conversationId, opts) {
			if (activeConversations.has(conversationId)) {
				return { error: "conversation is generating" };
			}

			const history = await deps.conversationStore.load(conversationId);
			const keepLastN = opts?.keepLastN ?? DEFAULT_KEEP_LAST_N;

			if (history.length <= keepLastN) {
				return { error: "conversation too short to compact" };
			}

			// Auto mode: check threshold (default 350k if not explicitly set;
			// 0 explicitly disables).
			if (opts?.auto === true) {
				const stored = await deps.conversationStore.getCompactThreshold(conversationId);
				const threshold = stored ?? DEFAULT_COMPACT_THRESHOLD;
				if (threshold <= 0) return { error: "auto-compact disabled" };
				const metrics = await deps.conversationStore.loadMetrics(conversationId);
				const lastTurn = metrics[metrics.length - 1];
				if (lastTurn === undefined) return { error: "no metrics" };
				const lastInputTokens = lastTurn.usage.inputTokens + (lastTurn.usage.cacheReadTokens ?? 0);
				if (lastInputTokens < threshold) return { error: "threshold not exceeded" };
			}

			// Split: old messages to summarize + recent messages to keep.
			const toSummarize = history.slice(0, history.length - keepLastN);
			const toKeep = history.slice(history.length - keepLastN);

			// Resolve provider
			let provider: ProviderContract;
			let modelOverride: string | undefined;
			if (opts?.modelName !== undefined && deps.resolveModel !== undefined) {
				const resolved = deps.resolveModel(opts.modelName);
				if (resolved === undefined) return { error: `unknown model: ${opts.modelName}` };
				provider = resolved.provider;
				modelOverride = resolved.model;
			} else {
				provider = deps.resolveProvider();
			}

			// Build the summarization request: system prompt + conversation text + instruction
			const conversationText = formatMessagesForSummary(toSummarize);
			const summaryRequest: ChatMessage = {
				role: "user",
				chunks: [
					{
						type: "text",
						text: `Please summarize the following conversation:\n\n${conversationText}`,
					},
				],
			};

			const providerOpts: ProviderStreamOptions = {
				maxTokens: 2000,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
				...(deps.logger !== undefined
					? { logger: deps.logger.child({ conversationId, attrs: { compaction: true } }) }
					: {}),
			};

			// Call the provider and accumulate the summary
			let summary = "";
			for await (const event of provider.stream([summaryRequest], [], {
				...providerOpts,
				systemPrompt: COMPACTION_SYSTEM_PROMPT,
			})) {
				if ((event as ProviderEvent).type === "text-delta") {
					summary += (event as { delta: string }).delta;
				} else if ((event as ProviderEvent).type === "error") {
					return { error: (event as { message: string }).message };
				}
			}

			if (summary.trim().length === 0) {
				return { error: "model produced empty summary" };
			}

			// Non-destructive: fork the full pre-compaction history to a new
			// archive conversation. The original conversation keeps its ID
			// (so messaging between agents still works) and gets the compacted
			// content. The archive inherits the original's compactedFrom,
			// creating a chain: A → Y → X → ...
			const archiveId = crypto.randomUUID();
			await deps.conversationStore.forkHistory(conversationId, archiveId);

			// Replace history: [system: summary] + recent messages
			const summaryMessage: ChatMessage = {
				role: "system",
				chunks: [
					{
						type: "text",
						text: `The following is a summary of the previous conversation:\n\n${summary}`,
					},
				],
			};

			await deps.conversationStore.replaceHistory(conversationId, [summaryMessage, ...toKeep]);
			await deps.conversationStore.setCompactedFrom(conversationId, archiveId);

			const result: CompactionResult = {
				summary,
				newConversationId: archiveId,
				messagesSummarized: toSummarize.length,
				messagesKept: toKeep.length,
			};

			deps.emit(conversationCompacted, {
				conversationId,
				newConversationId: archiveId,
				messagesSummarized: toSummarize.length,
				messagesKept: toKeep.length,
			});

			return result;
		},
	};
}
