import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import type {
	SurfaceCatalogEntry,
	SurfaceClientMessage,
	SurfaceServerMessage,
	SurfaceSpec,
} from "@dispatch/ui-contract";
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

// ── Per-connection state (mirrors extension.ts) ─────────────────────────────

interface ConnectionState {
	readonly subs: Set<string>;
	readonly providerDisposers: Map<string, () => void>;
}

// ── Server helper ───────────────────────────────────────────────────────────

function startServer(registry: SurfaceRegistry, port = 0) {
	return Bun.serve<ConnectionState>({
		port,
		fetch(req, srv) {
			const initial: ConnectionState = {
				subs: new Set(),
				providerDisposers: new Map(),
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
			},

			close(ws) {
				const state = ws.data;
				if (state) {
					for (const dispose of state.providerDisposers.values()) {
						dispose();
					}
				}
			},
		},
	});
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function waitForMessage(ws: WebSocket): Promise<SurfaceServerMessage> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for message")), 5000);
		function handler(ev: MessageEvent) {
			clearTimeout(timeout);
			ws.removeEventListener("message", handler);
			resolve(JSON.parse(ev.data as string) as SurfaceServerMessage);
		}
		ws.addEventListener("message", handler);
	});
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Bun.serve WebSocket server", () => {
	let server: ReturnType<typeof Bun.serve>;
	let port: number;

	beforeEach(() => {
		const provider = fakeProvider("demo", "Demo Surface");
		const registry = fakeRegistry([provider]);
		server = startServer(registry);
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
