/**
 * Pure core — routes a client WS message into an effect description.
 *
 * Zero I/O, zero ambient state. Every function is `input → output`:
 * it decides what to do but does NOT do it. The shell (extension.ts)
 * interprets the result: sends WS messages, mutates connSubs, calls
 * provider.invoke, drives the orchestrator.
 */

import type { SurfaceContext, SurfaceRegistry } from "@dispatch/surface-registry";
import type { ChatSendMessage, WsClientMessage } from "@dispatch/transport-contract";
import type { SurfaceServerMessage } from "@dispatch/ui-contract";

// ── Result types ────────────────────────────────────────────────────────────

/** The effect a surface client message should produce. */
export interface SurfaceRouteResult {
	readonly kind: "surface";
	/** Server messages to send back to this connection. */
	readonly replies: readonly SurfaceServerMessage[];
	/** Whether to add or remove the surface id from connSubs. */
	readonly subChange?: {
		readonly op: "add" | "remove";
		readonly surfaceId: string;
		readonly conversationId?: string;
	};
	/** If set, the shell must call `provider.invoke(actionId, payload, context)`. */
	readonly invoke?: {
		readonly surfaceId: string;
		readonly actionId: string;
		readonly payload?: unknown;
		readonly conversationId?: string;
	};
}

/** The effect a validated chat.send should produce. */
export interface ChatRouteResult {
	readonly kind: "chat";
	readonly conversationId: string | undefined;
	readonly message: string;
	readonly model: string | undefined;
	readonly cwd: string | undefined;
}

/** A malformed chat.send that should yield a chat.error reply. */
export interface ChatRouteError {
	readonly kind: "chat-error";
	readonly conversationId: string | undefined;
	readonly errorMessage: string;
}

/** The effect any client WS message should produce. */
export type RouteResult = SurfaceRouteResult | ChatRouteResult | ChatRouteError;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a subscription key from a surface id and optional conversation id.
 * The shell uses this same function so both layers agree on key format.
 */
export function subKey(surfaceId: string, conversationId?: string): string {
	return conversationId !== undefined ? `${surfaceId}::${conversationId}` : `${surfaceId}::`;
}

/** Build the catalog `SurfaceServerMessage` from the registry. */
export function catalogMessage(registry: SurfaceRegistry): SurfaceServerMessage {
	return { type: "catalog", catalog: registry.getCatalog() };
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Route a single client message into a pure effect description.
 *
 * @param registry  The surface registry (looked up once, injected).
 * @param connSubs  This connection's current subscription keys (via `subKey`).
 * @param msg       The parsed client message (surface or chat).
 */
export function routeClientMessage(
	registry: SurfaceRegistry,
	connSubs: ReadonlySet<string>,
	msg: WsClientMessage,
): RouteResult {
	switch (msg.type) {
		case "subscribe":
			return handleSubscribe(registry, connSubs, msg.surfaceId, msg.conversationId);
		case "unsubscribe":
			return handleUnsubscribe(msg.surfaceId, msg.conversationId);
		case "invoke":
			return handleInvoke(registry, msg.surfaceId, msg.actionId, msg.payload, msg.conversationId);
		case "chat.send":
			return handleChatSend(msg);
	}
}

// ── Chat validation ─────────────────────────────────────────────────────────

function handleChatSend(msg: ChatSendMessage): ChatRouteResult | ChatRouteError {
	if (typeof msg.message !== "string" || msg.message.length === 0) {
		return {
			kind: "chat-error",
			conversationId: msg.conversationId,
			errorMessage: "chat.send requires a non-empty string `message`",
		};
	}
	return {
		kind: "chat",
		conversationId: msg.conversationId,
		message: msg.message,
		model: msg.model,
		cwd: msg.cwd,
	};
}

// ── Per-message handlers ────────────────────────────────────────────────────

function handleSubscribe(
	registry: SurfaceRegistry,
	connSubs: ReadonlySet<string>,
	surfaceId: string,
	conversationId?: string,
): SurfaceRouteResult {
	const provider = registry.getSurface(surfaceId);
	if (!provider) {
		return {
			kind: "surface",
			replies: [{ type: "error", surfaceId, message: `Unknown surface: ${surfaceId}` }],
		};
	}

	const context: SurfaceContext | undefined =
		conversationId !== undefined ? { conversationId } : undefined;
	const spec = provider.getSpec(context);

	// getSpec may be sync or async — the pure core treats it as a value the
	// shell will resolve. We return the spec directly (it's a SurfaceSpec).
	// If it's a Promise the shell awaits it; if it's sync it's already the value.
	// For the pure core we just pass it through — the shell handles the resolution.
	const specValue = spec as import("@dispatch/ui-contract").SurfaceSpec;

	const replies: import("@dispatch/ui-contract").SurfaceServerMessage[] = [
		{
			type: "surface",
			spec: specValue,
			...(conversationId !== undefined ? { conversationId } : {}),
		},
	];

	// Idempotent: only emit subChange if not already subscribed.
	const key = subKey(surfaceId, conversationId);
	if (!connSubs.has(key)) {
		return {
			kind: "surface",
			replies,
			subChange: {
				op: "add",
				surfaceId,
				...(conversationId !== undefined ? { conversationId } : {}),
			},
		};
	}
	return { kind: "surface", replies };
}

function handleUnsubscribe(surfaceId: string, conversationId?: string): SurfaceRouteResult {
	return {
		kind: "surface",
		replies: [],
		subChange: {
			op: "remove",
			surfaceId,
			...(conversationId !== undefined ? { conversationId } : {}),
		},
	};
}

function handleInvoke(
	registry: SurfaceRegistry,
	surfaceId: string,
	actionId: string,
	payload?: unknown,
	conversationId?: string,
): SurfaceRouteResult {
	const provider = registry.getSurface(surfaceId);
	if (!provider) {
		return {
			kind: "surface",
			replies: [{ type: "error", surfaceId, message: `Unknown surface: ${surfaceId}` }],
		};
	}
	return {
		kind: "surface",
		replies: [],
		invoke: {
			surfaceId,
			actionId,
			payload,
			...(conversationId !== undefined ? { conversationId } : {}),
		},
	};
}
