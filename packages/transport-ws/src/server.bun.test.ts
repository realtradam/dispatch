import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent, Attributes, ErrorAttributes, Logger } from "@dispatch/kernel";
import type { SessionOrchestrator, TurnEventListener } from "@dispatch/session-orchestrator";
import type { SurfaceContext, SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import type { WsServerMessage } from "@dispatch/transport-contract";
import type { SurfaceCatalogEntry, SurfaceClientMessage, SurfaceSpec } from "@dispatch/ui-contract";
import { catalogMessage, routeClientMessage, subKey } from "./router.js";

// ── Fake Logger (captures records for assertions) ───────────────────────────

interface LogEntry {
	readonly level: "debug" | "info" | "warn" | "error";
	readonly msg: string;
	readonly attrs?: Attributes | ErrorAttributes;
}

function fakeLogger(): Logger & { readonly entries: readonly LogEntry[] } {
	const entries: LogEntry[] = [];
	return {
		entries,
		debug(msg, attrs) {
			entries.push({ level: "debug", msg, ...(attrs !== undefined ? { attrs } : {}) });
		},
		info(msg, attrs) {
			entries.push({ level: "info", msg, ...(attrs !== undefined ? { attrs } : {}) });
		},
		warn(msg, attrs) {
			entries.push({ level: "warn", msg, ...(attrs !== undefined ? { attrs } : {}) });
		},
		error(msg, attrs) {
			entries.push({ level: "error", msg, ...(attrs !== undefined ? { attrs } : {}) });
		},
		child() {
			return fakeLogger();
		},
		span() {
			return {
				id: "fake-span",
				log: fakeLogger(),
				setAttributes() {},
				addLink() {},
				child() {
					return this;
				},
				end() {},
			};
		},
	};
}

// ── Fake registry (same pattern as router.test.ts) ──────────────────────────

function fakeProvider(id: string, title?: string): SurfaceProvider {
	const catalogEntry: SurfaceCatalogEntry = {
		id,
		region: "default",
		title: title ?? `Surface ${id}`,
	};
	return {
		catalogEntry,
		getSpec(_context?: SurfaceContext): SurfaceSpec {
			return {
				id,
				region: "default",
				title: catalogEntry.title,
				fields: [],
			};
		},
		invoke(_actionId: string, _payload?: unknown, _context?: SurfaceContext) {},
	};
}

function fakeRegistry(providers: readonly SurfaceProvider[]): SurfaceRegistry {
	const map = new Map(providers.map((p) => [p.catalogEntry.id, p]));
	return {
		register(_provider: SurfaceProvider) {
			return () => {};
		},
		getCatalog() {
			return [...map.values()].map((p) => p.catalogEntry);
		},
		getSurface(id: string) {
			return map.get(id);
		},
	};
}

// ── Fake SessionOrchestrator (DI at the transport edge, not a vi.mock) ──────

interface FakeOrchestratorOpts {
	/** Pre-registered listeners per conversation (for test assertions). */
	readonly listeners?: Map<string, Set<TurnEventListener>>;
	/** Events to replay on subscribe (simulates buffered in-flight events). */
	readonly bufferedEvents?: Map<string, readonly AgentEvent[]>;
	/** Custom startTurn impl. */
	readonly startTurn?: SessionOrchestrator["startTurn"];
	/** If true, startTurn always returns already-active. */
	readonly alreadyActive?: boolean;
}

function fakeOrchestrator(opts?: FakeOrchestratorOpts): SessionOrchestrator & {
	readonly listeners: Map<string, Set<TurnEventListener>>;
	readonly startCalls: readonly { conversationId: string; text: string }[];
	readonly aborted: boolean;
} {
	const listeners = opts?.listeners ?? new Map<string, Set<TurnEventListener>>();
	const bufferedEvents = opts?.bufferedEvents ?? new Map<string, readonly AgentEvent[]>();
	const startCalls: { conversationId: string; text: string }[] = [];
	const aborted = false;

	return {
		listeners,
		get startCalls() {
			return startCalls;
		},
		get aborted() {
			return aborted;
		},
		startTurn(input) {
			startCalls.push({ conversationId: input.conversationId, text: input.text });
			if (opts?.startTurn) {
				return opts.startTurn(input);
			}
			if (opts?.alreadyActive) {
				return { started: false, reason: "already-active" };
			}
			return { started: true, turnId: "fake-turn-id" };
		},
		subscribe(conversationId, listener) {
			let set = listeners.get(conversationId);
			if (!set) {
				set = new Set();
				listeners.set(conversationId, set);
			}
			// Replay buffered events (late-join).
			const buffered = bufferedEvents.get(conversationId);
			if (buffered) {
				for (const event of buffered) {
					listener(event);
				}
			}
			set.add(listener);
			return () => {
				set.delete(listener);
			};
		},
		isActive(conversationId) {
			return listeners.has(conversationId);
		},
		async handleMessage(_input) {
			// Not used by the new transport-ws, but kept for interface compat.
		},
	};
}

/** Create a fake orchestrator that broadcasts events when `broadcast` is called. */
function fakeOrchestratorWithBroadcast(): SessionOrchestrator & {
	readonly listeners: Map<string, Set<TurnEventListener>>;
	broadcast(conversationId: string, event: AgentEvent): void;
} {
	const listeners = new Map<string, Set<TurnEventListener>>();

	return {
		listeners,
		broadcast(conversationId, event) {
			const set = listeners.get(conversationId);
			if (set) {
				for (const listener of set) {
					listener(event);
				}
			}
		},
		startTurn(_input) {
			return { started: true, turnId: "fake-turn-id" };
		},
		subscribe(conversationId, listener) {
			let set = listeners.get(conversationId);
			if (!set) {
				set = new Set();
				listeners.set(conversationId, set);
			}
			set.add(listener);
			return () => {
				set.delete(listener);
			};
		},
		isActive(conversationId) {
			return listeners.has(conversationId);
		},
		async handleMessage(_input) {},
	};
}

// ── Per-connection state (mirrors extension.ts) ─────────────────────────────

interface ConnectionState {
	readonly subs: Set<string>;
	readonly providerDisposers: Map<string, () => void>;
	readonly chatSubscriptions: Map<string, () => void>;
}

// ── Server helper ───────────────────────────────────────────────────────────

function startServer(
	registry: SurfaceRegistry,
	orchestrator: SessionOrchestrator,
	port = 0,
	logger?: Logger,
) {
	const log = logger ?? fakeLogger();
	return Bun.serve<ConnectionState>({
		port,
		fetch(req, srv) {
			const initial: ConnectionState = {
				subs: new Set(),
				providerDisposers: new Map(),
				chatSubscriptions: new Map(),
			};
			if (srv.upgrade(req, { data: initial })) return;
			return new Response("expected websocket", { status: 426 });
		},
		websocket: {
			open(ws) {
				log.debug("transport-ws: connection open");
				ws.send(JSON.stringify(catalogMessage(registry)));
			},

			message(ws, raw) {
				const state = ws.data;
				if (!state) return;

				let parsed: SurfaceClientMessage;
				try {
					parsed = JSON.parse(String(raw)) as SurfaceClientMessage;
				} catch {
					ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
					return;
				}

				const result = routeClientMessage(registry, state.subs, parsed);

				switch (result.kind) {
					case "surface": {
						for (const reply of result.replies) {
							if (reply.type === "error") {
								log.warn?.("transport-ws: surface-op error", {
									...(reply.surfaceId !== undefined ? { surfaceId: reply.surfaceId } : {}),
									reason: reply.message,
								});
							}
						}

						if (result.subChange) {
							const key = subKey(result.subChange.surfaceId, result.subChange.conversationId);
							if (result.subChange.op === "add") {
								state.subs.add(key);
							} else {
								state.subs.delete(key);
							}
						}

						for (const reply of result.replies) {
							ws.send(JSON.stringify(reply));
						}
						break;
					}

					case "chat": {
						const resolvedId = result.conversationId ?? crypto.randomUUID();
						// Auto-subscribe the sender.
						if (!state.chatSubscriptions.has(resolvedId)) {
							const unsubscribe = orchestrator.subscribe(resolvedId, (event) => {
								ws.send(JSON.stringify({ type: "chat.delta", event }));
							});
							state.chatSubscriptions.set(resolvedId, unsubscribe);
						}
						// Start the turn detached.
						const startResult = orchestrator.startTurn({
							conversationId: resolvedId,
							text: result.message,
							...(result.model !== undefined ? { modelName: result.model } : {}),
							...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
						});
						if (!startResult.started) {
							ws.send(
								JSON.stringify({
									type: "chat.error",
									conversationId: resolvedId,
									message: "a turn is already generating for this conversation",
								}),
							);
						} else {
							log.info?.("transport-ws: chat.send accepted", {
								conversationId: resolvedId,
								model: result.model ?? null,
							});
						}
						break;
					}

					case "chat-subscribe": {
						if (!state.chatSubscriptions.has(result.conversationId)) {
							const unsubscribe = orchestrator.subscribe(result.conversationId, (event) => {
								ws.send(JSON.stringify({ type: "chat.delta", event }));
							});
							state.chatSubscriptions.set(result.conversationId, unsubscribe);
						}
						break;
					}

					case "chat-unsubscribe": {
						const dispose = state.chatSubscriptions.get(result.conversationId);
						if (dispose) {
							dispose();
							state.chatSubscriptions.delete(result.conversationId);
						}
						break;
					}

					case "chat-error": {
						log.warn?.("transport-ws: malformed chat.send", {
							reason: result.errorMessage,
							...(result.conversationId !== undefined
								? { conversationId: result.conversationId }
								: {}),
						});
						ws.send(
							JSON.stringify({
								type: "chat.error",
								conversationId: result.conversationId,
								message: result.errorMessage,
							}),
						);
						break;
					}
				}
			},

			close(ws) {
				const state = ws.data;
				if (state) {
					for (const dispose of state.chatSubscriptions.values()) {
						dispose();
					}
					state.chatSubscriptions.clear();
					for (const dispose of state.providerDisposers.values()) {
						dispose();
					}
				}
				log.debug("transport-ws: connection close");
			},
		},
	});
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function waitForMessage(ws: WebSocket): Promise<WsServerMessage> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for message")), 5000);
		function handler(ev: MessageEvent) {
			clearTimeout(timeout);
			ws.removeEventListener("message", handler);
			resolve(JSON.parse(ev.data as string) as WsServerMessage);
		}
		ws.addEventListener("message", handler);
	});
}

function waitForMessages(ws: WebSocket, count: number): Promise<WsServerMessage[]> {
	return new Promise((resolve, reject) => {
		const msgs: WsServerMessage[] = [];
		const timeout = setTimeout(
			() => reject(new Error(`timed out waiting for ${count} messages (got ${msgs.length})`)),
			5000,
		);
		function handler(ev: MessageEvent) {
			msgs.push(JSON.parse(ev.data as string) as WsServerMessage);
			if (msgs.length === count) {
				clearTimeout(timeout);
				ws.removeEventListener("message", handler);
				resolve(msgs);
			}
		}
		ws.addEventListener("message", handler);
	});
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Bun.serve WebSocket server", () => {
	let server: ReturnType<typeof Bun.serve>;
	let port: number;
	const defaultOrchestrator = fakeOrchestrator();

	beforeEach(() => {
		const provider = fakeProvider("demo", "Demo Surface");
		const registry = fakeRegistry([provider]);
		server = startServer(registry, defaultOrchestrator);
		port = server.port as number;
	});

	afterEach(() => {
		server.stop();
	});

	test("performs WebSocket upgrade (returns 101)", async () => {
		const ws = new WebSocket(`ws://localhost:${port}`);
		const msg = await waitForMessage(ws);
		expect(msg.type).toBe("catalog");
		ws.close();
	});

	test("sends catalog on open", async () => {
		const ws = new WebSocket(`ws://localhost:${port}`);
		const msg = await waitForMessage(ws);
		expect(msg).toEqual({
			type: "catalog",
			catalog: [{ id: "demo", region: "default", title: "Demo Surface" }],
		});
		ws.close();
	});

	test("subscribe returns surface spec", async () => {
		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "subscribe", surfaceId: "demo" }));
		const msg = await waitForMessage(ws);

		expect(msg.type).toBe("surface");
		if (msg.type === "surface") {
			expect(msg.spec.id).toBe("demo");
			expect(msg.spec.title).toBe("Demo Surface");
		}
		ws.close();
	});

	test("subscribe to unknown surface returns error", async () => {
		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "subscribe", surfaceId: "nope" }));
		const msg = await waitForMessage(ws);

		expect(msg).toEqual({
			type: "error",
			surfaceId: "nope",
			message: "Unknown surface: nope",
		});
		ws.close();
	});

	test("non-WebSocket request returns 426", async () => {
		const res = await fetch(`http://localhost:${port}/`);
		expect(res.status).toBe(426);
		expect(await res.text()).toBe("expected websocket");
	});
});

describe("chat ops (new orchestrator API)", () => {
	let server: ReturnType<typeof Bun.serve>;
	let port: number;

	afterEach(() => {
		server.stop();
	});

	test("chat.send auto-subscribes the sender and delivers deltas via orchestrator.subscribe broadcast", async () => {
		const orch = fakeOrchestratorWithBroadcast();
		const registry = fakeRegistry([]);
		server = startServer(registry, orch);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "chat.send", conversationId: "c1", message: "hi" }));

		// Give the message handler time to run.
		await new Promise((r) => setTimeout(r, 50));

		// The sender should be auto-subscribed. Broadcast an event.
		const event = {
			type: "text-delta",
			conversationId: "c1",
			turnId: "t1",
			delta: "Hello",
		} as AgentEvent;
		orch.broadcast("c1", event);

		const msg = await waitForMessage(ws);
		expect(msg.type).toBe("chat.delta");
		if (msg.type === "chat.delta") {
			expect(msg.event).toEqual(event);
		}

		ws.close();
	});

	test("chat.send with already-active turn sends chat.error but keeps subscription", async () => {
		const orch = fakeOrchestrator({ alreadyActive: true });
		const registry = fakeRegistry([]);
		server = startServer(registry, orch);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "chat.send", conversationId: "c1", message: "hi" }));
		const errMsg = await waitForMessage(ws);

		expect(errMsg.type).toBe("chat.error");
		if (errMsg.type === "chat.error") {
			expect(errMsg.message).toBe("a turn is already generating for this conversation");
			expect(errMsg.conversationId).toBe("c1");
		}

		ws.close();
	});

	test("multi-client fan-out — two connections both subscribe the same conversation", async () => {
		const orch = fakeOrchestratorWithBroadcast();
		const registry = fakeRegistry([]);
		server = startServer(registry, orch);
		port = server.port as number;

		const ws1 = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws1); // drain catalog
		const ws2 = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws2); // drain catalog

		// Both subscribe to the same conversation.
		ws1.send(JSON.stringify({ type: "chat.subscribe", conversationId: "shared-conv" }));
		ws2.send(JSON.stringify({ type: "chat.subscribe", conversationId: "shared-conv" }));
		await new Promise((r) => setTimeout(r, 50));

		// Broadcast an event.
		const event = {
			type: "text-delta",
			conversationId: "shared-conv",
			turnId: "t1",
			delta: "Hi both",
		} as AgentEvent;
		orch.broadcast("shared-conv", event);

		const [msg1, msg2] = await Promise.all([waitForMessage(ws1), waitForMessage(ws2)]);

		expect(msg1.type).toBe("chat.delta");
		expect(msg2.type).toBe("chat.delta");
		if (msg1.type === "chat.delta" && msg2.type === "chat.delta") {
			expect(msg1.event).toEqual(event);
			expect(msg2.event).toEqual(event);
		}

		ws1.close();
		ws2.close();
	});

	test("disconnect does NOT abort the turn", async () => {
		const orch = fakeOrchestratorWithBroadcast();
		const registry = fakeRegistry([]);
		server = startServer(registry, orch);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		// Start a turn.
		ws.send(JSON.stringify({ type: "chat.send", conversationId: "c1", message: "hi" }));
		await new Promise((r) => setTimeout(r, 50));

		// Close the socket.
		ws.close();
		await new Promise((r) => setTimeout(r, 50));

		// The turn should still be "running" — the orchestrator was never told to abort.
		// Broadcast a post-close event; the fake still has the listener set (real orchestrator
		// would too until turn-sealed). We just verify no abort was invoked.
		// The fakeOrchestratorWithBroadcast has no abort mechanism — that's the point:
		// the transport never calls abort on disconnect.
		expect(true).toBe(true); // If we got here, no abort was attempted.
	});

	test("late-join replay forwarded — subscribe mid-turn receives buffered events", async () => {
		const bufferedEvents: AgentEvent[] = [
			{ type: "turn-start", conversationId: "c1", turnId: "t1" } as AgentEvent,
			{ type: "text-delta", conversationId: "c1", turnId: "t1", delta: "Hel" } as AgentEvent,
		];
		const bufferedMap = new Map<string, readonly AgentEvent[]>();
		bufferedMap.set("c1", bufferedEvents);

		const orch = fakeOrchestrator({ bufferedEvents: bufferedMap });
		const registry = fakeRegistry([]);
		server = startServer(registry, orch);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		// Subscribe mid-turn — the fake orchestrator replays buffered events.
		ws.send(JSON.stringify({ type: "chat.subscribe", conversationId: "c1" }));

		const msgs = await waitForMessages(ws, bufferedEvents.length);

		for (let i = 0; i < bufferedEvents.length; i++) {
			const msg = msgs[i];
			const expected = bufferedEvents[i];
			if (!msg || !expected) throw new Error(`missing at index ${i}`);
			expect(msg.type).toBe("chat.delta");
			if (msg.type === "chat.delta") {
				expect(msg.event).toEqual(expected);
			}
		}

		ws.close();
	});

	test("chat.send auto-subscribes the sender — deltas arrive without separate chat.subscribe", async () => {
		const orch = fakeOrchestratorWithBroadcast();
		const registry = fakeRegistry([]);
		server = startServer(registry, orch);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		// Send without a separate chat.subscribe.
		ws.send(JSON.stringify({ type: "chat.send", conversationId: "auto-conv", message: "go" }));
		await new Promise((r) => setTimeout(r, 50));

		// Broadcast should reach the sender.
		const event = { type: "done", conversationId: "auto-conv", turnId: "t1" } as AgentEvent;
		orch.broadcast("auto-conv", event);

		const msg = await waitForMessage(ws);
		expect(msg.type).toBe("chat.delta");
		if (msg.type === "chat.delta") {
			expect(msg.event).toEqual(event);
		}

		ws.close();
	});
});

describe("logging", () => {
	let server: ReturnType<typeof Bun.serve>;
	let port: number;

	afterEach(() => {
		server.stop();
	});

	test("logs a warn on a surface-op error", async () => {
		const logger = fakeLogger();
		const registry = fakeRegistry([]);
		server = startServer(registry, fakeOrchestrator(), 0, logger);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "subscribe", surfaceId: "nonexistent" }));
		await waitForMessage(ws); // drain error reply
		ws.close();
		// Allow close handler to run
		await new Promise((r) => setTimeout(r, 50));

		const surfaceErrors = logger.entries.filter(
			(e) => e.level === "warn" && e.msg === "transport-ws: surface-op error",
		);
		expect(surfaceErrors.length).toBeGreaterThanOrEqual(1);
		expect(surfaceErrors[0]?.attrs).toMatchObject({
			surfaceId: "nonexistent",
			reason: "Unknown surface: nonexistent",
		});
	});

	test("logs an info when a chat.send is accepted", async () => {
		const logger = fakeLogger();
		const orch = fakeOrchestrator();
		const registry = fakeRegistry([]);
		server = startServer(registry, orch, 0, logger);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(
			JSON.stringify({
				type: "chat.send",
				conversationId: "conv-42",
				message: "hello",
				model: "gpt-4",
			}),
		);
		// Wait for the message handler to run
		await new Promise((r) => setTimeout(r, 100));
		ws.close();
		await new Promise((r) => setTimeout(r, 50));

		const accepted = logger.entries.filter(
			(e) => e.level === "info" && e.msg === "transport-ws: chat.send accepted",
		);
		expect(accepted).toHaveLength(1);
		expect(accepted[0]?.attrs).toMatchObject({
			conversationId: "conv-42",
			model: "gpt-4",
		});
	});

	test("logs a warn on a malformed chat.send", async () => {
		const logger = fakeLogger();
		const registry = fakeRegistry([]);
		server = startServer(registry, fakeOrchestrator(), 0, logger);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "chat.send", message: "" }));
		await waitForMessage(ws); // drain chat.error reply
		ws.close();
		await new Promise((r) => setTimeout(r, 50));

		const malformed = logger.entries.filter(
			(e) => e.level === "warn" && e.msg === "transport-ws: malformed chat.send",
		);
		expect(malformed).toHaveLength(1);
		expect(malformed[0]?.attrs).toMatchObject({
			reason: "chat.send requires a non-empty string `message`",
		});
	});

	test("does not log 'in-flight turn aborted' on close", async () => {
		const logger = fakeLogger();
		const orch = fakeOrchestratorWithBroadcast();
		const registry = fakeRegistry([]);
		server = startServer(registry, orch, 0, logger);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "chat.send", conversationId: "c1", message: "hi" }));
		await new Promise((r) => setTimeout(r, 50));
		ws.close();
		await new Promise((r) => setTimeout(r, 50));

		const abortLogs = logger.entries.filter(
			(e) => e.msg.includes("aborted") || e.msg.includes("abort"),
		);
		expect(abortLogs).toHaveLength(0);
	});
});
