import type { ChatMessage, StorageNamespace } from "@dispatch/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { createConversationStore, isValidWorkspaceSlug } from "./store.js";

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
			if (!prefix) return all;
			return all.filter((k) => k.startsWith(prefix));
		},
	};
}

describe("WorkspaceStore", () => {
	let storage: StorageNamespace;
	let clock: number;

	beforeEach(() => {
		storage = createMemoryStorage();
		clock = 1000;
	});

	function makeStore() {
		return createConversationStore(storage, undefined, () => clock);
	}

	function userMessage(text: string): ChatMessage {
		return { role: "user", chunks: [{ type: "text", text }] };
	}

	it("ensureWorkspace creates with defaults", async () => {
		const store = makeStore();
		clock = 1000;
		const ws = await store.ensureWorkspace("my-work");
		expect(ws).toEqual({
			id: "my-work",
			title: "my-work",
			defaultCwd: null,
			createdAt: 1000,
			lastActivityAt: 1000,
		});
	});

	it("ensureWorkspace returns existing as-is", async () => {
		const store = makeStore();
		clock = 1000;
		await store.ensureWorkspace("my-work");
		clock = 2000;
		const ws = await store.ensureWorkspace("my-work", {
			title: "New Title",
			defaultCwd: "/ignored",
		});
		expect(ws).toEqual({
			id: "my-work",
			title: "my-work",
			defaultCwd: null,
			createdAt: 1000,
			lastActivityAt: 1000,
		});
	});

	it("ensureWorkspace with custom title/defaultCwd", async () => {
		const store = makeStore();
		clock = 3000;
		const ws = await store.ensureWorkspace("my-work", {
			title: "Custom",
			defaultCwd: "/projects/dispatch",
		});
		expect(ws).toEqual({
			id: "my-work",
			title: "Custom",
			defaultCwd: "/projects/dispatch",
			createdAt: 3000,
			lastActivityAt: 3000,
		});
	});

	it("getWorkspace synthesizes default", async () => {
		const store = makeStore();
		const ws = await store.getWorkspace("default");
		expect(ws).toEqual({
			id: "default",
			title: "default",
			defaultCwd: null,
			createdAt: 0,
			lastActivityAt: 0,
		});
	});

	it("getWorkspace returns null for unknown", async () => {
		const store = makeStore();
		expect(await store.getWorkspace("unknown")).toBeNull();
	});

	it("setWorkspaceTitle renames", async () => {
		const store = makeStore();
		clock = 1000;
		await store.ensureWorkspace("my-work");
		clock = 2000;
		const ws = await store.setWorkspaceTitle("my-work", "Renamed");
		expect(ws).toEqual({
			id: "my-work",
			title: "Renamed",
			defaultCwd: null,
			createdAt: 1000,
			lastActivityAt: 1000,
		});
	});

	it("setWorkspaceDefaultCwd sets and clears", async () => {
		const store = makeStore();
		clock = 1000;
		await store.ensureWorkspace("my-work");
		clock = 2000;
		const setWs = await store.setWorkspaceDefaultCwd("my-work", "/some/path");
		expect(setWs.defaultCwd).toBe("/some/path");
		expect(setWs.lastActivityAt).toBe(1000); // does not bump on defaultCwd change
		const cleared = await store.setWorkspaceDefaultCwd("my-work", null);
		expect(cleared.defaultCwd).toBeNull();
	});

	it("deleteWorkspace closes conversations", async () => {
		const store = makeStore();
		clock = 1000;
		await store.ensureWorkspace("work-a");
		await store.setWorkspaceId("conv1", "work-a");
		await store.setWorkspaceId("conv2", "work-a");
		await store.setWorkspaceId("conv3", "default");

		clock = 2000;
		await store.append("conv1", [userMessage("hi 1")]);
		await store.append("conv2", [userMessage("hi 2")]);
		await store.append("conv3", [userMessage("hi 3")]);

		const result = await store.deleteWorkspace("work-a");
		expect(result.closedCount).toBe(2);

		const meta1 = await store.getConversationMeta("conv1");
		expect(meta1?.status).toBe("closed");
		expect(meta1?.workspaceId).toBe("default");

		const meta2 = await store.getConversationMeta("conv2");
		expect(meta2?.status).toBe("closed");
		expect(meta2?.workspaceId).toBe("default");

		const meta3 = await store.getConversationMeta("conv3");
		expect(meta3?.status).toBe("idle");
		expect(meta3?.workspaceId).toBe("default");

		expect(await store.getWorkspace("work-a")).toBeNull();
	});

	it("deleteWorkspace throws for default", async () => {
		const store = makeStore();
		await expect(store.deleteWorkspace("default")).rejects.toThrow();
	});

	it("listWorkspaces sorted by lastActivityAt desc", async () => {
		const store = makeStore();
		clock = 1000;
		await store.ensureWorkspace("alpha");
		clock = 2000;
		await store.ensureWorkspace("beta");
		clock = 3000;
		await store.ensureWorkspace("gamma");

		const list = await store.listWorkspaces();
		expect(list.map((w) => w.id)).toEqual(["gamma", "beta", "alpha", "default"]);
	});

	it("listWorkspaces includes conversationCount", async () => {
		const store = makeStore();
		clock = 1000;
		await store.ensureWorkspace("work-a");
		await store.ensureWorkspace("work-b");
		await store.setWorkspaceId("a1", "work-a");
		await store.setWorkspaceId("a2", "work-a");
		await store.setWorkspaceId("b1", "work-b");
		await store.append("lonely", [userMessage("hi")]); // defaults to "default"

		const list = await store.listWorkspaces();
		const counts = Object.fromEntries(list.map((w) => [w.id, w.conversationCount]));
		expect(counts["work-a"]).toBe(2);
		expect(counts["work-b"]).toBe(1);
		expect(counts.default).toBe(1);
	});

	it("listWorkspaces always includes default", async () => {
		const store = makeStore();
		clock = 1000;
		await store.ensureWorkspace("only");
		// No append or explicit default creation — default is synthesized.
		const list = await store.listWorkspaces();
		const ids = list.map((w) => w.id);
		expect(ids).toContain("default");
		const defaultWs = list.find((w) => w.id === "default");
		expect(defaultWs).toEqual({
			id: "default",
			title: "default",
			defaultCwd: null,
			createdAt: 0,
			lastActivityAt: 0,
			conversationCount: 0,
		});
	});

	it("getWorkspaceId returns default for legacy", async () => {
		const store = makeStore();
		await store.append("conv1", [userMessage("hi")]);
		expect(await store.getWorkspaceId("conv1")).toBe("default");
		expect(await store.getWorkspaceId("never-seen")).toBe("default");
	});

	it("setWorkspaceId persists and reads back", async () => {
		const store = makeStore();
		clock = 1000;
		await store.setWorkspaceId("conv1", "my-work");
		expect(await store.getWorkspaceId("conv1")).toBe("my-work");
		const meta = await store.getConversationMeta("conv1");
		expect(meta?.workspaceId).toBe("my-work");
		expect(meta?.status).toBe("idle");
	});

	it("getEffectiveCwd explicit conversation", async () => {
		const store = makeStore();
		await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/default" });
		await store.setWorkspaceId("conv1", "my-work");
		await store.setCwd("conv1", "/explicit/path");
		expect(await store.getEffectiveCwd("conv1")).toBe("/explicit/path");
	});

	it("getEffectiveCwd inherits workspace default", async () => {
		const store = makeStore();
		await store.ensureWorkspace("my-work", { defaultCwd: "/workspace/default" });
		await store.setWorkspaceId("conv1", "my-work");
		expect(await store.getEffectiveCwd("conv1")).toBe("/workspace/default");
	});

	it("getEffectiveCwd returns null when nothing set", async () => {
		const store = makeStore();
		await store.ensureWorkspace("my-work");
		await store.setWorkspaceId("conv1", "my-work");
		expect(await store.getEffectiveCwd("conv1")).toBeNull();
	});

	it("listConversations filtered by workspaceId", async () => {
		const store = makeStore();
		await store.ensureWorkspace("work-a");
		await store.ensureWorkspace("work-b");
		await store.append("a1", [userMessage("a1")]);
		await store.append("a2", [userMessage("a2")]);
		await store.append("b1", [userMessage("b1")]);
		await store.setWorkspaceId("a1", "work-a");
		await store.setWorkspaceId("a2", "work-a");
		await store.setWorkspaceId("b1", "work-b");

		const aConvs = await store.listConversations({ workspaceId: "work-a" });
		expect(aConvs.map((c) => c.id).sort()).toEqual(["a1", "a2"]);

		const bConvs = await store.listConversations({ workspaceId: "work-b" });
		expect(bConvs.map((c) => c.id)).toEqual(["b1"]);
	});

	it("append updates workspace lastActivityAt", async () => {
		const store = makeStore();
		clock = 1000;
		await store.ensureWorkspace("my-work");
		clock = 2000;
		await store.setWorkspaceId("conv1", "my-work");
		clock = 3000;
		await store.append("conv1", [userMessage("hi")]);
		const ws = await store.getWorkspace("my-work");
		expect(ws?.lastActivityAt).toBe(3000);
	});

	it("forkHistory copies workspaceId", async () => {
		const store = makeStore();
		await store.ensureWorkspace("my-work");
		await store.setWorkspaceId("source", "my-work");
		await store.append("source", [userMessage("hello")]);
		await store.forkHistory("source", "target");
		const targetMeta = await store.getConversationMeta("target");
		expect(targetMeta?.workspaceId).toBe("my-work");
	});

	it("replaceHistory preserves workspaceId", async () => {
		const store = makeStore();
		await store.ensureWorkspace("my-work");
		await store.setWorkspaceId("conv1", "my-work");
		await store.append("conv1", [userMessage("original")]);
		await store.replaceHistory("conv1", [userMessage("replaced")]);
		const meta = await store.getConversationMeta("conv1");
		expect(meta?.workspaceId).toBe("my-work");
	});
});

describe("isValidWorkspaceSlug", () => {
	it("accepts valid slugs", () => {
		expect(isValidWorkspaceSlug("my-work")).toBe(true);
		expect(isValidWorkspaceSlug("default")).toBe(true);
		expect(isValidWorkspaceSlug("a1b2")).toBe(true);
	});

	it("rejects invalid slugs", () => {
		expect(isValidWorkspaceSlug("My-Work")).toBe(false);
		expect(isValidWorkspaceSlug("-leading")).toBe(false);
		expect(isValidWorkspaceSlug("trailing-")).toBe(false);
		expect(isValidWorkspaceSlug("")).toBe(false);
		expect(isValidWorkspaceSlug("a".repeat(41))).toBe(false);
		expect(isValidWorkspaceSlug("has space")).toBe(false);
	});
});
