import type { StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
	applyConfigUpdate,
	createHeartbeatConfigStore,
	DEFAULT_HEARTBEAT_CONFIG,
} from "./config-store.js";

function createMemoryStorage(): StorageNamespace {
	const data = new Map<string, string>();
	return {
		get: async (key) => data.get(key) ?? null,
		set: async (key, value) => {
			data.set(key, value);
		},
		delete: async (key) => {
			data.delete(key);
		},
		has: async (key) => data.has(key),
		keys: async (prefix) => {
			const all = [...data.keys()];
			if (prefix === undefined) return all;
			return all.filter((k) => k.startsWith(prefix));
		},
	};
}

describe("applyConfigUpdate (pure)", () => {
	it("leaves omitted fields unchanged from the default", () => {
		const next = applyConfigUpdate(DEFAULT_HEARTBEAT_CONFIG, {});
		expect(next).toEqual(DEFAULT_HEARTBEAT_CONFIG);
	});

	it("applies provided fields", () => {
		const next = applyConfigUpdate(DEFAULT_HEARTBEAT_CONFIG, {
			enabled: true,
			systemPrompt: "you are a monitor",
			taskPrompt: "check for stuck chats",
			model: "opencode/gpt-4o",
		});
		expect(next.enabled).toBe(true);
		expect(next.systemPrompt).toBe("you are a monitor");
		expect(next.taskPrompt).toBe("check for stuck chats");
		expect(next.model).toBe("opencode/gpt-4o");
		// Untouched fields keep defaults.
		expect(next.intervalMinutes).toBe(30);
		expect(next.reasoningEffort).toBeNull();
	});

	it("clamps intervalMinutes to a minimum of 1", () => {
		expect(applyConfigUpdate(DEFAULT_HEARTBEAT_CONFIG, { intervalMinutes: 0 }).intervalMinutes).toBe(
			1,
		);
		expect(
			applyConfigUpdate(DEFAULT_HEARTBEAT_CONFIG, { intervalMinutes: -5 }).intervalMinutes,
		).toBe(1);
		expect(applyConfigUpdate(DEFAULT_HEARTBEAT_CONFIG, { intervalMinutes: 7 }).intervalMinutes).toBe(
			7,
		);
	});

	it("truncates a non-integer interval to an integer", () => {
		expect(
			applyConfigUpdate(DEFAULT_HEARTBEAT_CONFIG, { intervalMinutes: 12.9 }).intervalMinutes,
		).toBe(12);
	});

	it("clears reasoningEffort when null is passed", () => {
		const withEffort = applyConfigUpdate(DEFAULT_HEARTBEAT_CONFIG, { reasoningEffort: "high" });
		expect(withEffort.reasoningEffort).toBe("high");
		const cleared = applyConfigUpdate(withEffort, { reasoningEffort: null });
		expect(cleared.reasoningEffort).toBeNull();
	});

	it("treats an absent reasoningEffort as unchanged (distinct from null)", () => {
		const withEffort = applyConfigUpdate(DEFAULT_HEARTBEAT_CONFIG, { reasoningEffort: "low" });
		const untouched = applyConfigUpdate(withEffort, { enabled: true });
		expect(untouched.reasoningEffort).toBe("low");
	});
});

describe("createHeartbeatConfigStore", () => {
	it("returns the default config for an unknown workspace", async () => {
		const store = createHeartbeatConfigStore(createMemoryStorage());
		expect(await store.get("ws-1")).toEqual(DEFAULT_HEARTBEAT_CONFIG);
	});

	it("persists and round-trips an update", async () => {
		const storage = createMemoryStorage();
		const store = createHeartbeatConfigStore(storage);
		const next = await store.update("ws-1", { enabled: true, intervalMinutes: 5 });
		expect(next.enabled).toBe(true);
		expect(next.intervalMinutes).toBe(5);
		// A fresh store over the same storage reads the persisted value.
		const store2 = createHeartbeatConfigStore(storage);
		expect(await store2.get("ws-1")).toEqual(next);
	});

	it("applies a partial update on top of existing config", async () => {
		const storage = createMemoryStorage();
		const store = createHeartbeatConfigStore(storage);
		await store.update("ws-1", { enabled: true, systemPrompt: "a", taskPrompt: "b" });
		const next = await store.update("ws-1", { taskPrompt: "c" });
		expect(next.enabled).toBe(true);
		expect(next.systemPrompt).toBe("a");
		expect(next.taskPrompt).toBe("c");
	});

	it("lists persisted workspace ids", async () => {
		const store = createHeartbeatConfigStore(createMemoryStorage());
		await store.update("ws-b", { enabled: true });
		await store.update("ws-a", { enabled: false });
		expect(await store.listWorkspaceIds()).toEqual(["ws-a", "ws-b"]);
	});
});
