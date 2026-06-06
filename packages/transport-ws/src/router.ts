/**
 * Pure core — routes a client WS message into an effect description.
 *
 * Zero I/O, zero ambient state. Every function is `input → output`:
 * it decides what to do but does NOT do it. The shell (extension.ts)
 * interprets the result: sends WS messages, mutates connSubs, calls
 * provider.invoke.
 */

import type { SurfaceRegistry } from "@dispatch/surface-registry";
import type { SurfaceClientMessage, SurfaceServerMessage } from "@dispatch/ui-contract";

// ── Result types ────────────────────────────────────────────────────────────

/** The effect a single client message should produce. */
export interface RouteResult {
	/** Server messages to send back to this connection. */
	readonly replies: readonly SurfaceServerMessage[];
	/** Whether to add or remove the surface id from connSubs. */
	readonly subChange?: { readonly op: "add" | "remove"; readonly surfaceId: string };
	/** If set, the shell must call `provider.invoke(actionId, payload)`. */
	readonly invoke?: {
		readonly surfaceId: string;
		readonly actionId: string;
		readonly payload?: unknown;
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build the catalog `SurfaceServerMessage` from the registry. */
export function catalogMessage(registry: SurfaceRegistry): SurfaceServerMessage {
	return { type: "catalog", catalog: registry.getCatalog() };
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Route a single client message into a pure effect description.
 *
 * @param registry  The surface registry (looked up once, injected).
 * @param connSubs  This connection's current subscribed surface ids.
 * @param msg       The parsed client message.
 */
export function routeClientMessage(
	registry: SurfaceRegistry,
	connSubs: ReadonlySet<string>,
	msg: SurfaceClientMessage,
): RouteResult {
	switch (msg.type) {
		case "subscribe":
			return handleSubscribe(registry, connSubs, msg.surfaceId);
		case "unsubscribe":
			return handleUnsubscribe(msg.surfaceId);
		case "invoke":
			return handleInvoke(registry, msg.surfaceId, msg.actionId, msg.payload);
	}
}

// ── Per-message handlers ────────────────────────────────────────────────────

function handleSubscribe(
	registry: SurfaceRegistry,
	connSubs: ReadonlySet<string>,
	surfaceId: string,
): RouteResult {
	const provider = registry.getSurface(surfaceId);
	if (!provider) {
		return {
			replies: [{ type: "error", surfaceId, message: `Unknown surface: ${surfaceId}` }],
		};
	}

	const spec = provider.getSpec();

	// getSpec may be sync or async — the pure core treats it as a value the
	// shell will resolve. We return the spec directly (it's a SurfaceSpec).
	// If it's a Promise the shell awaits it; if it's sync it's already the value.
	// For the pure core we just pass it through — the shell handles the resolution.
	const specValue = spec as import("@dispatch/ui-contract").SurfaceSpec;

	const replies: import("@dispatch/ui-contract").SurfaceServerMessage[] = [
		{ type: "surface", spec: specValue },
	];

	// Idempotent: only emit subChange if not already subscribed.
	if (!connSubs.has(surfaceId)) {
		return { replies, subChange: { op: "add", surfaceId } };
	}
	return { replies };
}

function handleUnsubscribe(surfaceId: string): RouteResult {
	return {
		replies: [],
		subChange: { op: "remove", surfaceId },
	};
}

function handleInvoke(
	registry: SurfaceRegistry,
	surfaceId: string,
	actionId: string,
	payload?: unknown,
): RouteResult {
	const provider = registry.getSurface(surfaceId);
	if (!provider) {
		return {
			replies: [{ type: "error", surfaceId, message: `Unknown surface: ${surfaceId}` }],
		};
	}
	return {
		replies: [],
		invoke: { surfaceId, actionId, payload },
	};
}
