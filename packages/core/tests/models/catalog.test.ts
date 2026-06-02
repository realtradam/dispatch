import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetCatalogCacheForTests,
	getModelsCatalog,
	resolveContextLimit,
} from "../../src/models/catalog.js";

const CACHE_PATH = "/tmp/dispatch/models-dev.json";

// A trimmed models.dev-shaped catalog covering the providers we support.
const CATALOG = {
	anthropic: {
		id: "anthropic",
		models: {
			"claude-sonnet-4-5": { limit: { context: 200000, output: 64000 } },
			"claude-sonnet-4-6": { limit: { context: 1000000, output: 64000 } },
		},
	},
	opencode: {
		id: "opencode",
		models: {
			"glm-4-6": { limit: { context: 131072, output: 8192 } },
		},
	},
};

function mockFetchOnce(catalog: unknown, ok = true, status = 200) {
	const fn = vi.fn(() =>
		Promise.resolve({
			ok,
			status,
			text: () => Promise.resolve(JSON.stringify(catalog)),
		} as Response),
	);
	vi.stubGlobal("fetch", fn);
	return fn;
}

beforeEach(() => {
	__resetCatalogCacheForTests();
	if (existsSync(CACHE_PATH)) rmSync(CACHE_PATH);
	delete process.env.DISPATCH_DISABLE_MODELS_FETCH;
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (existsSync(CACHE_PATH)) rmSync(CACHE_PATH);
});

describe("resolveContextLimit", () => {
	it("resolves a known anthropic model to its context window", async () => {
		mockFetchOnce(CATALOG);
		expect(await resolveContextLimit("anthropic", "claude-sonnet-4-5")).toBe(200000);
		expect(await resolveContextLimit("anthropic", "claude-sonnet-4-6")).toBe(1000000);
	});

	it("maps opencode-anthropic to the anthropic catalog, then opencode fallback", async () => {
		mockFetchOnce(CATALOG);
		// Present in the anthropic catalog.
		expect(await resolveContextLimit("opencode-anthropic", "claude-sonnet-4-5")).toBe(200000);
		// Absent in anthropic, found in the opencode gateway catalog.
		expect(await resolveContextLimit("opencode-anthropic", "glm-4-6")).toBe(131072);
	});

	it("returns null for an unknown model id", async () => {
		mockFetchOnce(CATALOG);
		expect(await resolveContextLimit("anthropic", "no-such-model")).toBeNull();
	});

	it("returns null for an unsupported provider (no network needed)", async () => {
		const fetchFn = mockFetchOnce(CATALOG);
		expect(await resolveContextLimit("google", "gemini-2.5-pro")).toBeNull();
		expect(await resolveContextLimit("anthropic", "")).toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("returns null when the model has no positive context limit", async () => {
		mockFetchOnce({
			anthropic: { id: "anthropic", models: { broken: { limit: { context: 0 } } } },
		});
		expect(await resolveContextLimit("anthropic", "broken")).toBeNull();
	});

	it("does not throw on a malformed provider entry missing `models`", async () => {
		// A provider object without a `models` map must degrade to null, not crash.
		mockFetchOnce({ anthropic: { id: "anthropic" } });
		expect(await resolveContextLimit("anthropic", "claude-sonnet-4-5")).toBeNull();
	});

	it("does not throw when limit/context fields are absent", async () => {
		mockFetchOnce({ anthropic: { id: "anthropic", models: { m: {} } } });
		expect(await resolveContextLimit("anthropic", "m")).toBeNull();
	});
});

describe("getModelsCatalog caching", () => {
	it("fetches once and serves the in-process memo on subsequent calls", async () => {
		const fetchFn = mockFetchOnce(CATALOG);
		await resolveContextLimit("anthropic", "claude-sonnet-4-5");
		await resolveContextLimit("anthropic", "claude-sonnet-4-6");
		await getModelsCatalog();
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("reuses a fresh disk cache without re-fetching across processes", async () => {
		// Simulate another process having written a fresh cache.
		writeFileSync(CACHE_PATH, JSON.stringify(CATALOG), "utf-8");
		const fetchFn = vi.fn(() => Promise.reject(new Error("network should not be hit")));
		vi.stubGlobal("fetch", fetchFn);
		expect(await resolveContextLimit("anthropic", "claude-sonnet-4-5")).toBe(200000);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("falls back to a STALE disk cache when the network fails", async () => {
		writeFileSync(CACHE_PATH, JSON.stringify(CATALOG), "utf-8");
		// Age the cache well past the TTL so the fetch path is taken.
		const old = Date.now() / 1000 - 3600;
		utimesSync(CACHE_PATH, old, old);
		const fetchFn = vi.fn(() => Promise.reject(new Error("offline")));
		vi.stubGlobal("fetch", fetchFn);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(await resolveContextLimit("anthropic", "claude-sonnet-4-5")).toBe(200000);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("returns null when fetch fails and no cache exists", async () => {
		const fetchFn = vi.fn(() => Promise.reject(new Error("offline")));
		vi.stubGlobal("fetch", fetchFn);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await resolveContextLimit("anthropic", "claude-sonnet-4-5")).toBeNull();
		warn.mockRestore();
	});

	it("does not hit the network when DISPATCH_DISABLE_MODELS_FETCH is set", async () => {
		process.env.DISPATCH_DISABLE_MODELS_FETCH = "1";
		const fetchFn = vi.fn(() => Promise.reject(new Error("should not fetch")));
		vi.stubGlobal("fetch", fetchFn);
		expect(await resolveContextLimit("anthropic", "claude-sonnet-4-5")).toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("memoizes the fallback after a failed fetch so it does not re-hit the network", async () => {
		const fetchFn = vi.fn(() => Promise.reject(new Error("offline")));
		vi.stubGlobal("fetch", fetchFn);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		// First lookup triggers the (failing) fetch.
		expect(await resolveContextLimit("anthropic", "claude-sonnet-4-5")).toBeNull();
		// Subsequent lookups within the penalty window must NOT re-fetch.
		expect(await resolveContextLimit("anthropic", "claude-sonnet-4-6")).toBeNull();
		await getModelsCatalog();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});
