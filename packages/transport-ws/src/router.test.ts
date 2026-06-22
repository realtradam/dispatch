import type { SurfaceContext, SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import type { WsClientMessage } from "@dispatch/transport-contract";
import type { SurfaceCatalogEntry, SurfaceSpec } from "@dispatch/ui-contract";
import { describe, expect, it } from "vitest";
import { catalogMessage, type RouteResult, routeClientMessage, subKey } from "./router.js";

// ── Fake in-memory registry (no mocks — just a plain implementation) ────────

interface FakeProviderOpts {
	readonly id: string;
	readonly title?: string;
	readonly actions?: readonly string[];
	/** Called with the context that getSpec receives — for test assertions. */
	readonly onGetSpec?: (context: SurfaceContext | undefined) => void;
	/** Called with the context that invoke receives — for test assertions. */
	readonly onInvoke?: (
		actionId: string,
		payload: unknown,
		context: SurfaceContext | undefined,
	) => void;
}

function fakeProvider(
	idOrOpts: string | FakeProviderOpts,
	title?: string,
	actions?: readonly string[],
): SurfaceProvider {
	const opts: FakeProviderOpts =
		typeof idOrOpts === "string"
			? {
					id: idOrOpts,
					...(title !== undefined ? { title } : {}),
					...(actions !== undefined ? { actions } : {}),
				}
			: idOrOpts;
	const catalogEntry: SurfaceCatalogEntry = {
		id: opts.id,
		region: "default",
		title: opts.title ?? `Surface ${opts.id}`,
	};
	return {
		catalogEntry,
		getSpec(context?: SurfaceContext): SurfaceSpec {
			opts.onGetSpec?.(context);
			return {
				id: opts.id,
				region: "default",
				title: catalogEntry.title,
				fields:
					opts.actions?.map((a) => ({
						kind: "button" as const,
						label: a,
						action: { actionId: a },
					})) ?? [],
			};
		},
		invoke(actionId: string, _payload?: unknown, context?: SurfaceContext) {
			opts.onInvoke?.(actionId, _payload, context);
		},
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("routeClientMessage", () => {
	describe("subscribe", () => {
		it("replies with `surface` and tracks the subscription", () => {
			const provider = fakeProvider("a", "Surface A");
			const registry = fakeRegistry([provider]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "subscribe",
				surfaceId: "a",
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(result.replies).toHaveLength(1);
			expect(result.replies[0]).toEqual({
				type: "surface",
				spec: {
					id: "a",
					region: "default",
					title: "Surface A",
					fields: [],
				},
			});
			expect(result.subChange).toEqual({ op: "add", surfaceId: "a" });
		});

		it("is idempotent — subscribing twice does not duplicate the subChange", () => {
			const provider = fakeProvider("a");
			const registry = fakeRegistry([provider]);
			const connSubs = new Set<string>([subKey("a")]); // already subscribed (global)

			const result = routeClientMessage(registry, connSubs, {
				type: "subscribe",
				surfaceId: "a",
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(result.replies).toHaveLength(1);
			expect(result.replies[0]?.type).toBe("surface");
			expect(result.subChange).toBeUndefined();
		});

		it("returns `error` for an unknown surface id", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "subscribe",
				surfaceId: "nonexistent",
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(result.replies).toHaveLength(1);
			expect(result.replies[0]).toEqual({
				type: "error",
				surfaceId: "nonexistent",
				message: "Unknown surface: nonexistent",
			});
			expect(result.subChange).toBeUndefined();
		});

		it("subscribe with conversationId fetches the provider spec for that conversation and tags the reply", () => {
			let receivedContext: SurfaceContext | undefined;
			const provider = fakeProvider({
				id: "cache-warm",
				title: "Cache Warming",
				onGetSpec(ctx) {
					receivedContext = ctx;
				},
			});
			const registry = fakeRegistry([provider]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "subscribe",
				surfaceId: "cache-warm",
				conversationId: "conv-42",
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(receivedContext).toEqual({ conversationId: "conv-42" });
			expect(result.replies).toHaveLength(1);
			const reply = result.replies[0];
			if (reply?.type !== "surface") throw new Error("expected surface reply");
			expect(reply.conversationId).toBe("conv-42");
			expect(reply.spec.id).toBe("cache-warm");
			expect(result.subChange).toEqual({
				op: "add",
				surfaceId: "cache-warm",
				conversationId: "conv-42",
			});
		});

		it("subscribe without conversationId behaves as before (global surface unaffected)", () => {
			let receivedContext: SurfaceContext | undefined;
			const provider = fakeProvider({
				id: "global-surf",
				title: "Global Surface",
				onGetSpec(ctx) {
					receivedContext = ctx;
				},
			});
			const registry = fakeRegistry([provider]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "subscribe",
				surfaceId: "global-surf",
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(receivedContext).toBeUndefined();
			const reply = result.replies[0];
			if (reply?.type !== "surface") throw new Error("expected surface reply");
			expect(reply.conversationId).toBeUndefined();
			expect(result.subChange).toEqual({ op: "add", surfaceId: "global-surf" });
		});
	});

	describe("unsubscribe", () => {
		it("emits a remove subChange and no replies", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>([subKey("a")]);

			const result = routeClientMessage(registry, connSubs, {
				type: "unsubscribe",
				surfaceId: "a",
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(result.replies).toHaveLength(0);
			expect(result.subChange).toEqual({ op: "remove", surfaceId: "a" });
		});

		it("emits remove even if not currently subscribed (idempotent)", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "unsubscribe",
				surfaceId: "a",
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(result.replies).toHaveLength(0);
			expect(result.subChange).toEqual({ op: "remove", surfaceId: "a" });
		});
	});

	describe("invoke", () => {
		it("signals the invoke effect for a known surface", () => {
			const provider = fakeProvider("a", "Surface A", ["toggle"]);
			const registry = fakeRegistry([provider]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "invoke",
				surfaceId: "a",
				actionId: "toggle",
				payload: true,
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(result.replies).toHaveLength(0);
			expect(result.invoke).toEqual({
				surfaceId: "a",
				actionId: "toggle",
				payload: true,
			});
		});

		it("returns `error` for an unknown surface id", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "invoke",
				surfaceId: "nonexistent",
				actionId: "toggle",
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(result.replies).toHaveLength(1);
			expect(result.replies[0]).toEqual({
				type: "error",
				surfaceId: "nonexistent",
				message: "Unknown surface: nonexistent",
			});
			expect(result.invoke).toBeUndefined();
		});

		it("invoke forwards the conversationId to the provider", () => {
			let _receivedContext: SurfaceContext | undefined;
			const provider = fakeProvider({
				id: "cache-warm",
				title: "Cache Warming",
				actions: ["warm"],
				onInvoke(_actionId, _payload, ctx) {
					_receivedContext = ctx;
				},
			});
			const registry = fakeRegistry([provider]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "invoke",
				surfaceId: "cache-warm",
				actionId: "warm",
				payload: { force: true },
				conversationId: "conv-99",
			});

			expect(result.kind).toBe("surface");
			if (result.kind !== "surface") throw new Error("expected surface");
			expect(result.invoke).toEqual({
				surfaceId: "cache-warm",
				actionId: "warm",
				payload: { force: true },
				conversationId: "conv-99",
			});
		});
	});

	describe("chat.send", () => {
		it("classifies a chat.send message", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.send",
				message: "hello",
			});

			expect(result.kind).toBe("chat");
			if (result.kind !== "chat") throw new Error("expected chat");
			expect(result.message).toBe("hello");
			expect(result.conversationId).toBeUndefined();
			expect(result.model).toBeUndefined();
			expect(result.cwd).toBeUndefined();
		});

		it("passes through optional fields", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.send",
				conversationId: "conv-123",
				message: "follow up",
				model: "gpt-4",
				cwd: "/tmp",
			});

			expect(result.kind).toBe("chat");
			if (result.kind !== "chat") throw new Error("expected chat");
			expect(result.conversationId).toBe("conv-123");
			expect(result.message).toBe("follow up");
			expect(result.model).toBe("gpt-4");
			expect(result.cwd).toBe("/tmp");
		});

		it("chat.send threads workspaceId", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.send",
				conversationId: "conv-ws",
				message: "hello workspace",
				workspaceId: "my-workspace",
			});

			expect(result.kind).toBe("chat");
			if (result.kind !== "chat") throw new Error("expected chat");
			expect(result.workspaceId).toBe("my-workspace");
		});

		it("chat.send defaults workspaceId when omitted", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.send",
				message: "hello no workspace",
			});

			expect(result.kind).toBe("chat");
			if (result.kind !== "chat") throw new Error("expected chat");
			// workspaceId is absent (undefined) — the orchestrator receives no
			// workspaceId and applies its own "default" resolution.
			expect(result).not.toHaveProperty("workspaceId");
		});

		it("rejects a malformed chat.send (empty message)", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.send",
				message: "",
			});

			expect(result.kind).toBe("chat-error");
			if (result.kind !== "chat-error") throw new Error("expected chat-error");
			expect(result.errorMessage).toContain("non-empty string");
		});

		it("rejects a malformed chat.send (missing message)", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.send",
				message: undefined as unknown as string,
			});

			expect(result.kind).toBe("chat-error");
			if (result.kind !== "chat-error") throw new Error("expected chat-error");
			expect(result.errorMessage).toContain("non-empty string");
		});

		it("threads each valid reasoningEffort level through to the result", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();
			const levels = ["low", "medium", "high", "xhigh", "max"] as const;

			for (const level of levels) {
				const result = routeClientMessage(registry, connSubs, {
					type: "chat.send",
					message: "hello",
					reasoningEffort: level,
				});

				expect(result.kind).toBe("chat");
				if (result.kind !== "chat") throw new Error("expected chat");
				expect(result.reasoningEffort).toBe(level);
			}
		});

		it("omits reasoningEffort from result when not provided by client", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.send",
				message: "hello",
			});

			expect(result.kind).toBe("chat");
			if (result.kind !== "chat") throw new Error("expected chat");
			expect(result).not.toHaveProperty("reasoningEffort");
		});

		it("rejects an invalid reasoningEffort value with a chat-error", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.send",
				message: "hello",
				reasoningEffort: "turbo" as unknown as "low",
			});

			expect(result.kind).toBe("chat-error");
			if (result.kind !== "chat-error") throw new Error("expected chat-error");
			expect(result.errorMessage).toContain("invalid reasoningEffort");
			expect(result.errorMessage).toContain("turbo");
		});
	});

	describe("chat.subscribe", () => {
		it("routes chat.subscribe → { kind: 'chat-subscribe', conversationId }", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.subscribe",
				conversationId: "conv-abc",
			});

			expect(result).toEqual({ kind: "chat-subscribe", conversationId: "conv-abc" });
		});
	});

	describe("chat.unsubscribe", () => {
		it("routes chat.unsubscribe → { kind: 'chat-unsubscribe', conversationId }", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.unsubscribe",
				conversationId: "conv-abc",
			});

			expect(result).toEqual({ kind: "chat-unsubscribe", conversationId: "conv-abc" });
		});
	});

	describe("chat.queue", () => {
		it("routes a valid chat.queue → { kind: 'chat-queue', conversationId, text } (what the shell passes to orchestrator.enqueue)", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.queue",
				conversationId: "conv-1",
				text: "steer here",
			});

			expect(result).toEqual({
				kind: "chat-queue",
				conversationId: "conv-1",
				text: "steer here",
			});
		});

		it("chat.queue threads workspaceId", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.queue",
				conversationId: "conv-ws",
				text: "steer here",
				workspaceId: "my-workspace",
			});

			expect(result.kind).toBe("chat-queue");
			if (result.kind !== "chat-queue") throw new Error("expected chat-queue");
			expect(result.workspaceId).toBe("my-workspace");
		});

		it("rejects empty/whitespace text → chat-error (no enqueue signal)", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			for (const text of ["", "   ", "\t\n"]) {
				const result = routeClientMessage(registry, connSubs, {
					type: "chat.queue",
					conversationId: "conv-1",
					text,
				});

				expect(result.kind).toBe("chat-error");
				if (result.kind !== "chat-error") throw new Error("expected chat-error");
				expect(result.conversationId).toBe("conv-1");
				expect(result.errorMessage).toContain("non-empty string");
				expect(result.errorMessage).toContain("text");
			}
		});

		it("rejects missing text → chat-error (no enqueue signal)", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			const result = routeClientMessage(registry, connSubs, {
				type: "chat.queue",
				conversationId: "conv-1",
				text: undefined as unknown as string,
			});

			expect(result.kind).toBe("chat-error");
			if (result.kind !== "chat-error") throw new Error("expected chat-error");
			expect(result.errorMessage).toContain("non-empty string");
		});

		it("does not trim the stored text — passes the original through to the shell", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>();

			// Non-empty after trim (so valid), but the value carries surrounding
			// whitespace: the router passes it through unchanged (validation uses
			// trim; the orchestrator receives the original text).
			const result = routeClientMessage(registry, connSubs, {
				type: "chat.queue",
				conversationId: "conv-1",
				text: "  steer  ",
			});

			expect(result.kind).toBe("chat-queue");
			if (result.kind !== "chat-queue") throw new Error("expected chat-queue");
			expect(result.text).toBe("  steer  ");
		});
	});

	describe("exhaustive switch (regression guard for Wave-0 fan-out)", () => {
		// Every WsClientMessage variant must route to a defined result with a
		// known kind — no fall-through / undefined return. If the union is
		// widened again, `tsc` catches the missing case (the switch is
		// exhaustive); this test guards the runtime side of that contract.
		it("routes every WsClientMessage variant to a defined RouteResult", () => {
			const provider = fakeProvider("a", "Surface A", ["toggle"]);
			const registry = fakeRegistry([provider]);
			const connSubs = new Set<string>();

			const samples: WsClientMessage[] = [
				{ type: "subscribe", surfaceId: "a" },
				{ type: "unsubscribe", surfaceId: "a" },
				{ type: "invoke", surfaceId: "a", actionId: "toggle", payload: true },
				{ type: "chat.send", message: "hi" },
				{ type: "chat.subscribe", conversationId: "c1" },
				{ type: "chat.unsubscribe", conversationId: "c1" },
				{ type: "chat.queue", conversationId: "c1", text: "steer" },
			];

			const validKinds = new Set<RouteResult["kind"]>([
				"surface",
				"chat",
				"chat-error",
				"chat-subscribe",
				"chat-unsubscribe",
				"chat-queue",
			]);

			for (const msg of samples) {
				const result = routeClientMessage(registry, connSubs, msg);
				expect(result).toBeDefined();
				expect(validKinds.has(result.kind)).toBe(true);
			}
		});
	});
});

describe("catalogMessage", () => {
	it("returns the catalog from the registry", () => {
		const providerA = fakeProvider("a", "Surface A");
		const providerB = fakeProvider("b", "Surface B");
		const registry = fakeRegistry([providerA, providerB]);

		const msg = catalogMessage(registry);

		expect(msg).toEqual({
			type: "catalog",
			catalog: [
				{ id: "a", region: "default", title: "Surface A" },
				{ id: "b", region: "default", title: "Surface B" },
			],
		});
	});

	it("returns an empty catalog when no providers are registered", () => {
		const registry = fakeRegistry([]);

		const msg = catalogMessage(registry);

		expect(msg).toEqual({ type: "catalog", catalog: [] });
	});
});

describe("subKey", () => {
	it("builds a global key when conversationId is undefined", () => {
		expect(subKey("surf-a")).toBe("surf-a::");
	});

	it("builds a conversation-scoped key when conversationId is provided", () => {
		expect(subKey("surf-a", "conv-42")).toBe("surf-a::conv-42");
	});

	it("global and conversation-scoped keys are distinct", () => {
		expect(subKey("surf-a")).not.toBe(subKey("surf-a", "conv-42"));
	});
});
