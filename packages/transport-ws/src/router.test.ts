import type { SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import type { SurfaceCatalogEntry, SurfaceSpec } from "@dispatch/ui-contract";
import { describe, expect, it } from "vitest";
import { catalogMessage, routeClientMessage } from "./router.js";

// ── Fake in-memory registry (no mocks — just a plain implementation) ────────

function fakeProvider(id: string, title?: string, actions?: readonly string[]): SurfaceProvider {
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
				fields:
					actions?.map((a) => ({
						kind: "button" as const,
						label: a,
						action: { actionId: a },
					})) ?? [],
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
			const connSubs = new Set<string>(["a"]); // already subscribed

			const result = routeClientMessage(registry, connSubs, {
				type: "subscribe",
				surfaceId: "a",
			});

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

			expect(result.replies).toHaveLength(1);
			expect(result.replies[0]).toEqual({
				type: "error",
				surfaceId: "nonexistent",
				message: "Unknown surface: nonexistent",
			});
			expect(result.subChange).toBeUndefined();
		});
	});

	describe("unsubscribe", () => {
		it("emits a remove subChange and no replies", () => {
			const registry = fakeRegistry([]);
			const connSubs = new Set<string>(["a"]);

			const result = routeClientMessage(registry, connSubs, {
				type: "unsubscribe",
				surfaceId: "a",
			});

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

			expect(result.replies).toHaveLength(1);
			expect(result.replies[0]).toEqual({
				type: "error",
				surfaceId: "nonexistent",
				message: "Unknown surface: nonexistent",
			});
			expect(result.invoke).toBeUndefined();
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
