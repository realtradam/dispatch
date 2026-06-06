import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent } from "@dispatch/kernel";
import type { SessionOrchestrator } from "@dispatch/session-orchestrator";
import type { SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import type { WsServerMessage } from "@dispatch/transport-contract";
import type { SurfaceCatalogEntry, SurfaceClientMessage, SurfaceSpec } from "@dispatch/ui-contract";
import { catalogMessage, routeClientMessage } from "./router.js";

// ── Fake registry (same pattern as router.test.ts) ──────────────────────────

function fakeProvider(id: string, title?: string): SurfaceProvider {
	const catalogEntry: SurfaceCatalogEntry = {
		id,
		region: "default",
		title: title ?? `Surface ${id}`,
	};
	return {
		catalogEntry,
		getSpec(): SurfaceSpec {
			return {
				id,
				region: "default",
				title: catalogEntry.title,
				fields: [],
			};
		},
		invoke(_actionId: string, _payload?: unknown) {},
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

function startServer(registry: SurfaceRegistry, orchestrator: SessionOrchestrator, port = 0) {
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
						if (result.subChange) {
							if (result.subChange.op === "add") {
								state.subs.add(result.subChange.surfaceId);
							} else {
								state.subs.delete(result.subChange.surfaceId);
							}
						}

						for (const reply of result.replies) {
							ws.send(JSON.stringify(reply));
						}
						break;
					}

					case "chat": {
						const resolvedId = result.conversationId ?? crypto.randomUUID();
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
							}
						})();
						break;
					}

					case "chat-error": {
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
					state.abortController.abort();
					for (const dispose of state.providerDisposers.values()) {
						dispose();
					}
				}
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
