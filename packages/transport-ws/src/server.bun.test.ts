import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent, Attributes, ErrorAttributes, Logger } from "@dispatch/kernel";
import type { SessionOrchestrator } from "@dispatch/session-orchestrator";
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

function fakeOrchestrator(handler?: SessionOrchestrator["handleMessage"]): SessionOrchestrator {
	return {
		handleMessage: handler ?? (async () => {}),
	};
}

// ── Per-connection state (mirrors extension.ts) ─────────────────────────────

interface ConnectionState {
	readonly subs: Set<string>;
	readonly providerDisposers: Map<string, () => void>;
	readonly abortController: AbortController;
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
				abortController: new AbortController(),
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
						log.info?.("transport-ws: chat.send accepted", {
							conversationId: resolvedId,
							model: result.model ?? null,
						});
						void (async () => {
							try {
								await orchestrator.handleMessage({
									conversationId: resolvedId,
									text: result.message,
									...(result.model !== undefined ? { modelName: result.model } : {}),
									...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
									signal: state.abortController.signal,
									onEvent(event) {
										ws.send(JSON.stringify({ type: "chat.delta", event }));
									},
								});
							} catch (err: unknown) {
								const message = err instanceof Error ? err.message : "unknown orchestrator error";
								ws.send(
									JSON.stringify({
										type: "chat.error",
										conversationId: resolvedId,
										message,
									}),
								);
								log.warn?.("transport-ws: chat turn failed", {
									conversationId: resolvedId,
									error: message,
								});
							}
						})();
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
					if (!state.abortController.signal.aborted) {
						log.debug("transport-ws: in-flight turn aborted (socket closed)");
					}
					state.abortController.abort();
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

describe("chat ops", () => {
	let server: ReturnType<typeof Bun.serve>;
	let port: number;

	afterEach(() => {
		server.stop();
	});

	test("chat.send streams AgentEvents back as chat.delta in order", async () => {
		const events: AgentEvent[] = [
			{ type: "turn-start", conversationId: "c1", turnId: "t1" } as AgentEvent,
			{ type: "text-delta", conversationId: "c1", turnId: "t1", delta: "Hello" } as AgentEvent,
			{ type: "text-delta", conversationId: "c1", turnId: "t1", delta: " world" } as AgentEvent,
			{ type: "done", conversationId: "c1", turnId: "t1" } as AgentEvent,
			{ type: "turn-sealed", conversationId: "c1", turnId: "t1" } as AgentEvent,
		];

		const orchestrator = fakeOrchestrator(async (input) => {
			for (const event of events) {
				input.onEvent(event);
			}
		});

		const registry = fakeRegistry([]);
		server = startServer(registry, orchestrator);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "chat.send", message: "hi" }));

		const msgs = await waitForMessages(ws, events.length);

		for (let i = 0; i < events.length; i++) {
			const msg = msgs[i];
			const expected = events[i];
			if (!msg || !expected) throw new Error(`missing at index ${i}`);
			expect(msg.type).toBe("chat.delta");
			if (msg.type === "chat.delta") {
				expect(msg.event).toEqual(expected);
			}
		}

		ws.close();
	});

	test("chat orchestrator failure yields chat.error without crashing the connection", async () => {
		const orchestrator = fakeOrchestrator(async () => {
			throw new Error("boom");
		});

		const registry = fakeRegistry([fakeProvider("demo", "Demo")]);
		server = startServer(registry, orchestrator);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		// Send a chat.send that will fail
		ws.send(JSON.stringify({ type: "chat.send", message: "trigger failure" }));
		const errMsg = await waitForMessage(ws);

		expect(errMsg.type).toBe("chat.error");
		if (errMsg.type === "chat.error") {
			expect(errMsg.message).toBe("boom");
		}

		// Socket must still be alive — send a surface subscribe to prove it
		ws.send(JSON.stringify({ type: "subscribe", surfaceId: "demo" }));
		const surfaceMsg = await waitForMessage(ws);
		expect(surfaceMsg.type).toBe("surface");

		ws.close();
	});

	test("chat.send with empty message yields chat.error (pure router rejection)", async () => {
		const orchestrator = fakeOrchestrator();
		const registry = fakeRegistry([]);
		server = startServer(registry, orchestrator);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "chat.send", message: "" }));
		const errMsg = await waitForMessage(ws);

		expect(errMsg.type).toBe("chat.error");
		if (errMsg.type === "chat.error") {
			expect(errMsg.message).toContain("non-empty string");
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
		const orchestrator = fakeOrchestrator(async () => {});
		const registry = fakeRegistry([]);
		server = startServer(registry, orchestrator, 0, logger);
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
		// Wait for the async turn to complete
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

	test("does not log a line per chat.delta frame", async () => {
		const logger = fakeLogger();
		const events: AgentEvent[] = [
			{ type: "turn-start", conversationId: "c1", turnId: "t1" } as AgentEvent,
			{ type: "text-delta", conversationId: "c1", turnId: "t1", delta: "H" } as AgentEvent,
			{ type: "text-delta", conversationId: "c1", turnId: "t1", delta: "e" } as AgentEvent,
			{ type: "text-delta", conversationId: "c1", turnId: "t1", delta: "l" } as AgentEvent,
			{ type: "text-delta", conversationId: "c1", turnId: "t1", delta: "l" } as AgentEvent,
			{ type: "text-delta", conversationId: "c1", turnId: "t1", delta: "o" } as AgentEvent,
			{ type: "done", conversationId: "c1", turnId: "t1" } as AgentEvent,
			{ type: "turn-sealed", conversationId: "c1", turnId: "t1" } as AgentEvent,
		];

		const orchestrator = fakeOrchestrator(async (input) => {
			for (const event of events) {
				input.onEvent(event);
			}
		});

		const registry = fakeRegistry([]);
		server = startServer(registry, orchestrator, 0, logger);
		port = server.port as number;

		const ws = new WebSocket(`ws://localhost:${port}`);
		await waitForMessage(ws); // drain catalog

		ws.send(JSON.stringify({ type: "chat.send", message: "hello" }));
		await waitForMessages(ws, events.length);
		ws.close();
		await new Promise((r) => setTimeout(r, 50));

		// Should only have: debug(open) + info(accepted) + debug(abort) + debug(close) = 4
		// NOT one log line per delta frame
		const chatDeltaLogs = logger.entries.filter(
			(e) => e.msg.includes("chat.delta") || e.msg.includes("text-delta"),
		);
		expect(chatDeltaLogs).toHaveLength(0);

		// Total log lines should be small (open + accepted + close, maybe abort)
		const chatRelated = logger.entries.filter((e) => e.msg.startsWith("transport-ws:"));
		expect(chatRelated.length).toBeLessThanOrEqual(5);
	});
});
