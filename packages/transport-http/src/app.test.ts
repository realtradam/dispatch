import type {
	AgentEvent,
	ChatMessage,
	ConversationMeta,
	HostAPI,
	Logger,
	ReasoningEffort,
	StepId,
	StorageNamespace,
	StoredChunk,
	TurnMetrics,
} from "@dispatch/kernel";
import { createThroughputStore, dayKeyOf } from "@dispatch/throughput-store";
import type {
	DeleteWorkspaceResponse,
	QueuedMessage,
	QueueResponse,
	ThroughputResponse,
	WorkspaceListResponse,
	WorkspaceResponse,
} from "@dispatch/transport-contract";
import type { Workspace } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { extractLastAssistantText } from "./logic.js";
import type {
	ConversationStore,
	CredentialStore,
	LspService,
	SessionOrchestrator,
	WarmService,
} from "./seam.js";
import { conversationOpened } from "./seam.js";

function createMemStorage(): StorageNamespace {
	const map = new Map<string, string>();
	return {
		get: async (k) => map.get(k) ?? null,
		set: async (k, v) => {
			map.set(k, v);
		},
		delete: async (k) => {
			map.delete(k);
		},
		has: async (k) => map.has(k),
		keys: async (prefix) =>
			[...map.keys()].filter((k) => (prefix === undefined ? true : k.startsWith(prefix))),
	};
}

interface CapturedLog {
	readonly level: "debug" | "info" | "warn" | "error";
	readonly msg: string;
	readonly attrs?: Record<string, unknown>;
}

function createFakeLogger(): Logger & { readonly records: readonly CapturedLog[] } {
	const records: CapturedLog[] = [];
	return {
		get records() {
			return records;
		},
		debug(msg, attrs) {
			records.push({ level: "debug", msg, ...(attrs ? { attrs } : {}) });
		},
		info(msg, attrs) {
			records.push({ level: "info", msg, ...(attrs ? { attrs } : {}) });
		},
		warn(msg, attrs) {
			records.push({ level: "warn", msg, ...(attrs ? { attrs } : {}) });
		},
		error(msg, attrs) {
			records.push({ level: "error", msg, ...(attrs ? { attrs } : {}) });
		},
		child() {
			return createFakeLogger();
		},
		span() {
			return {
				id: "fake-span",
				log: createFakeLogger(),
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

function createFakeConversationStore(
	store: Map<string, StoredChunk[]> = new Map(),
	metricsStore: Map<string, TurnMetrics[]> = new Map(),
	cwdStore: Map<string, string> = new Map(),
	reasoningEffortStore: Map<string, ReasoningEffort> = new Map(),
): ConversationStore {
	return {
		async append() {},
		async load() {
			return [];
		},
		async loadSince(conversationId, sinceSeq, window) {
			const chunks = store.get(conversationId) ?? [];
			const minSeq = sinceSeq ?? 0;
			const beforeSeq = window?.beforeSeq;
			const limit = window?.limit;
			const selected = chunks.filter(
				(c) => c.seq > minSeq && (beforeSeq === undefined || c.seq < beforeSeq),
			);
			// Window: keep only the NEWEST `limit`, still ascending by seq.
			if (limit !== undefined && selected.length > limit) {
				return selected.slice(selected.length - limit);
			}
			return selected;
		},
		async appendMetrics() {},
		async loadMetrics(conversationId) {
			return metricsStore.get(conversationId) ?? [];
		},
		async getCwd(conversationId) {
			return cwdStore.get(conversationId) ?? null;
		},
		async setCwd(conversationId, cwd) {
			cwdStore.set(conversationId, cwd);
		},
		async clearCwd(conversationId) {
			cwdStore.delete(conversationId);
		},
		async getReasoningEffort(conversationId) {
			return reasoningEffortStore.get(conversationId) ?? null;
		},
		async setReasoningEffort(conversationId, effort) {
			reasoningEffortStore.set(conversationId, effort);
		},
		async listConversations() {
			return [];
		},
		async getConversationMeta() {
			return null;
		},
		async setConversationTitle() {},
		async getConversationStatus() {
			return null;
		},
		async setConversationStatus() {},
		async replaceHistory() {},
		async getCompactPercent() {
			return null;
		},
		async setCompactPercent() {},
		async forkHistory() {},
		async setCompactedFrom() {},
		async getWorkspace() {
			return null;
		},
		async ensureWorkspace() {
			return { id: "default", title: "default", defaultCwd: null, createdAt: 0, lastActivityAt: 0 };
		},
		async setWorkspaceTitle() {
			return { id: "default", title: "default", defaultCwd: null, createdAt: 0, lastActivityAt: 0 };
		},
		async setWorkspaceDefaultCwd() {
			return { id: "default", title: "default", defaultCwd: null, createdAt: 0, lastActivityAt: 0 };
		},
		async deleteWorkspace() {
			return { closedCount: 0 };
		},
		async listWorkspaces() {
			return [];
		},
		async getWorkspaceId() {
			return "default";
		},
		async setWorkspaceId() {},
		async getEffectiveCwd(conversationId) {
			return cwdStore.get(conversationId) ?? null;
		},
	};
}

/**
 * Wraps a ConversationStore to record the ORDER of mutating calls
 * (ensureWorkspace, setWorkspaceId, setCwd) as a labeled list — so tests can
 * assert that workspace assignment happens BEFORE setCwd.
 */
function createCallTrackingStore(
	base: ConversationStore,
): ConversationStore & { readonly calls: readonly string[] } {
	const calls: string[] = [];
	return {
		...base,
		get calls() {
			return calls;
		},
		async ensureWorkspace(id, opts) {
			calls.push(`ensureWorkspace:${id}`);
			return base.ensureWorkspace(id, opts);
		},
		async setWorkspaceId(conversationId, workspaceId) {
			calls.push(`setWorkspaceId:${workspaceId}`);
			await base.setWorkspaceId(conversationId, workspaceId);
		},
		async setCwd(conversationId, cwd) {
			calls.push(`setCwd:${cwd}`);
			await base.setCwd(conversationId, cwd);
		},
	};
}

function createFakeOrchestrator(events: AgentEvent[]): SessionOrchestrator {
	return {
		startTurn() {
			return { started: true, turnId: "fake-turn" };
		},
		subscribe() {
			return () => {};
		},
		isActive() {
			return false;
		},
		enqueue() {
			return { startedTurn: false, queue: [] };
		},
		closeConversation() {
			return { abortedTurn: false };
		},
		stopTurn() {
			return { abortedTurn: false };
		},
		async handleMessage(input) {
			for (const event of events) {
				input.onEvent(event);
			}
		},
	};
}

function createCapturingOrchestrator(): SessionOrchestrator & {
	received: Parameters<SessionOrchestrator["handleMessage"]>[0] | undefined;
} {
	const state: {
		received: Parameters<SessionOrchestrator["handleMessage"]>[0] | undefined;
	} = { received: undefined };
	return {
		get received() {
			return state.received;
		},
		startTurn() {
			return { started: true, turnId: "fake-turn" };
		},
		subscribe() {
			return () => {};
		},
		isActive() {
			return false;
		},
		enqueue() {
			return { startedTurn: false, queue: [] };
		},
		closeConversation() {
			return { abortedTurn: false };
		},
		stopTurn() {
			return { abortedTurn: false };
		},
		async handleMessage(input) {
			state.received = input;
		},
	};
}

function createThrowingOrchestrator(error: Error): SessionOrchestrator {
	return {
		startTurn() {
			return { started: true, turnId: "fake-turn" };
		},
		subscribe() {
			return () => {};
		},
		isActive() {
			return false;
		},
		enqueue() {
			return { startedTurn: false, queue: [] };
		},
		closeConversation() {
			return { abortedTurn: false };
		},
		stopTurn() {
			return { abortedTurn: false };
		},
		async handleMessage() {
			throw error;
		},
	};
}

function createFakeCredentialStore(models: string[]): CredentialStore {
	return {
		resolve() {
			return undefined;
		},
		async getModelInfo() {
			return undefined;
		},
		async listCatalog() {
			return models;
		},
	};
}

function createThrowingCredentialStore(error: Error): CredentialStore {
	return {
		resolve() {
			return undefined;
		},
		async getModelInfo() {
			return undefined;
		},
		async listCatalog() {
			throw error;
		},
	};
}

function createFakeWarmService(
	result:
		| {
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheWriteTokens: number;
		  }
		| { error: string },
): WarmService {
	return {
		async warm() {
			return result;
		},
	};
}

function createFakeLspService(
	statuses: readonly {
		readonly id: string;
		readonly name: string;
		readonly root: string;
		readonly extensions: readonly string[];
		readonly state: "connected" | "starting" | "error" | "not-started";
		readonly error?: string;
	}[] = [],
): LspService {
	return {
		async status() {
			return statuses;
		},
	};
}

function createCapturingLspService(
	statuses: readonly {
		readonly id: string;
		readonly name: string;
		readonly root: string;
		readonly extensions: readonly string[];
		readonly state: "connected" | "starting" | "error" | "not-started";
		readonly error?: string;
	}[] = [],
): LspService & { readonly statusCalls: readonly string[] } {
	const calls: string[] = [];
	return {
		get statusCalls() {
			return calls;
		},
		async status(cwd) {
			calls.push(cwd);
			return statuses;
		},
	};
}

const noopLogger = createFakeLogger();

describe("GET /health", () => {
	it("returns ok", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
	});
});

describe("GET /models", () => {
	it("returns model catalog", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore(["opencode/m1", "openai/gpt-4"]),
			logger: noopLogger,
		});
		const res = await app.request("/models");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { models: readonly string[] };
		expect(body.models).toEqual(["opencode/m1", "openai/gpt-4"]);
	});

	it("returns empty array when no models", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/models");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { models: readonly string[] };
		expect(body.models).toEqual([]);
	});

	it("returns 502 when listCatalog throws", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createThrowingCredentialStore(new Error("db down")),
			logger: noopLogger,
		});
		const res = await app.request("/models");
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Failed to retrieve model catalog");
	});
});

describe("POST /chat", () => {
	it("returns 400 for invalid JSON", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 for missing message", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: "c1" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("message");
	});

	it("returns 400 for empty message", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("streams events as NDJSON", async () => {
		const events: AgentEvent[] = [
			{ type: "turn-start", conversationId: "tab1", turnId: "turn1" },
			{ type: "text-delta", conversationId: "tab1", turnId: "turn1", delta: "Hello" },
			{ type: "text-delta", conversationId: "tab1", turnId: "turn1", delta: " world" },
			{ type: "done", conversationId: "tab1", turnId: "turn1", reason: "stop" },
		];
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator(events),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi", conversationId: "conv1" }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
		expect(res.headers.get("X-Conversation-Id")).toBe("conv1");

		const text = await res.text();
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(4);

		const parsed = lines.map((line) => JSON.parse(line) as AgentEvent);
		expect(parsed[0]?.type).toBe("turn-start");
		expect(parsed[1]?.type).toBe("text-delta");
		expect((parsed[1] as { delta: string }).delta).toBe("Hello");
		expect(parsed[2]?.type).toBe("text-delta");
		expect(parsed[3]?.type).toBe("done");
	});

	it("generates conversationId when not provided", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([
				{ type: "done", conversationId: "tab1", turnId: "turn1", reason: "stop" },
			]),
			credentialStore: createFakeCredentialStore([]),
			generateId: () => "generated-uuid",
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("X-Conversation-Id")).toBe("generated-uuid");
	});

	it("emits error event when orchestrator throws", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createThrowingOrchestrator(new Error("provider unavailable")),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi", conversationId: "conv1" }),
		});

		expect(res.status).toBe(200);
		const text = await res.text();
		const lines = text.trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(1);

		const lastLine = lines[lines.length - 1];
		if (!lastLine) throw new Error("expected at least one line");
		const lastEvent = JSON.parse(lastLine) as AgentEvent;
		expect(lastEvent.type).toBe("error");
		if (lastEvent.type === "error") {
			expect(lastEvent.message).toContain("provider unavailable");
		}
	});

	it("handles empty event list", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});

		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toBe("");
	});

	it("forwards modelName and cwd to orchestrator", async () => {
		const cap = createCapturingOrchestrator();
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: cap,
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "hi",
				conversationId: "conv1",
				model: "opencode/m1",
				cwd: "/tmp",
			}),
		});

		expect(res.status).toBe(200);
		expect(cap.received).toBeDefined();
		expect(cap.received?.conversationId).toBe("conv1");
		expect(cap.received?.text).toBe("hi");
		expect(cap.received?.modelName).toBe("opencode/m1");
		expect(cap.received?.cwd).toBe("/tmp");
	});

	it("omits modelName and cwd when not provided", async () => {
		const cap = createCapturingOrchestrator();
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: cap,
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi", conversationId: "conv1" }),
		});

		expect(res.status).toBe(200);
		expect(cap.received).toBeDefined();
		expect(cap.received?.modelName).toBeUndefined();
		expect(cap.received?.cwd).toBeUndefined();
	});
});

describe("POST /chat/warm", () => {
	it("POST /chat/warm returns 200 with cachePct from the warm usage", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			warmService: createFakeWarmService({
				inputTokens: 1000,
				outputTokens: 200,
				cacheReadTokens: 800,
				cacheWriteTokens: 100,
			}),
			logger: noopLogger,
		});

		const res = await app.request("/chat/warm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: "conv1" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			cachePct: number;
			expectedCacheRate: number;
		};
		expect(body.inputTokens).toBe(1000);
		expect(body.outputTokens).toBe(200);
		expect(body.cacheReadTokens).toBe(800);
		expect(body.cacheWriteTokens).toBe(100);
		expect(body.cachePct).toBe(80);
		expect(body.expectedCacheRate).toBe(89);
	});

	it("POST /chat/warm returns expectedCacheRate = round(cacheRead/(cacheRead+cacheWrite)*100)", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			warmService: createFakeWarmService({
				inputTokens: 500,
				outputTokens: 100,
				cacheReadTokens: 400,
				cacheWriteTokens: 100,
			}),
			logger: noopLogger,
		});

		const res = await app.request("/chat/warm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: "conv1" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { expectedCacheRate: number };
		expect(body.expectedCacheRate).toBe(80);
	});

	it("POST /chat/warm returns expectedCacheRate = 0 when cacheRead+cacheWrite is 0", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			warmService: createFakeWarmService({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
			logger: noopLogger,
		});

		const res = await app.request("/chat/warm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: "conv1" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { expectedCacheRate: number };
		expect(body.expectedCacheRate).toBe(0);
	});

	it("POST /chat/warm returns 409 when the warm service reports the conversation is generating", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			warmService: createFakeWarmService({ error: "conversation is generating" }),
			logger: noopLogger,
		});

		const res = await app.request("/chat/warm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: "conv1" }),
		});

		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("conversation is generating");
	});

	it("POST /chat/warm returns 400 when conversationId is missing", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			warmService: createFakeWarmService({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
			logger: noopLogger,
		});

		const res = await app.request("/chat/warm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("conversationId");
	});
});

describe("GET /conversations/:id", () => {
	const sampleChunks: StoredChunk[] = [
		{ seq: 1, role: "user", chunk: { type: "text", text: "hello" } },
		{ seq: 2, role: "assistant", chunk: { type: "text", text: "hi there" } },
		{ seq: 3, role: "user", chunk: { type: "text", text: "how are you?" } },
		{ seq: 4, role: "assistant", chunk: { type: "text", text: "I'm good!" } },
	];

	it("returns the full seq-ordered StoredChunk history", async () => {
		const store = new Map<string, StoredChunk[]>([["conv1", sampleChunks]]);
		const app = createApp({
			conversationStore: createFakeConversationStore(store),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/conversations/conv1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		expect(body.chunks).toHaveLength(4);
		expect(body.chunks[0]?.seq).toBe(1);
		expect(body.chunks[3]?.seq).toBe(4);
		expect(body.latestSeq).toBe(4);
	});

	it("returns only chunks with seq > N and latestSeq = last seq", async () => {
		const store = new Map<string, StoredChunk[]>([["conv1", sampleChunks]]);
		const app = createApp({
			conversationStore: createFakeConversationStore(store),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/conversations/conv1?sinceSeq=2");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		expect(body.chunks).toHaveLength(2);
		expect(body.chunks[0]?.seq).toBe(3);
		expect(body.chunks[1]?.seq).toBe(4);
		expect(body.latestSeq).toBe(4);
	});

	it("returns empty chunks and latestSeq === sinceSeq when caught up", async () => {
		const store = new Map<string, StoredChunk[]>([["conv1", sampleChunks]]);
		const app = createApp({
			conversationStore: createFakeConversationStore(store),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/conversations/conv1?sinceSeq=4");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		expect(body.chunks).toHaveLength(0);
		expect(body.latestSeq).toBe(4);
	});

	it("returns empty chunks and latestSeq 0 for unknown conversation", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/conversations/unknown");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		expect(body.chunks).toHaveLength(0);
		expect(body.latestSeq).toBe(0);
	});

	it("returns 400 for invalid sinceSeq", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/conversations/conv1?sinceSeq=abc");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("sinceSeq");
	});

	it("returns 400 for negative sinceSeq", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/conversations/conv1?sinceSeq=-1");
		expect(res.status).toBe(400);
	});

	const sixChunks: StoredChunk[] = [
		{ seq: 1, role: "user", chunk: { type: "text", text: "one" } },
		{ seq: 2, role: "assistant", chunk: { type: "text", text: "two" } },
		{ seq: 3, role: "user", chunk: { type: "text", text: "three" } },
		{ seq: 4, role: "assistant", chunk: { type: "text", text: "four" } },
		{ seq: 5, role: "user", chunk: { type: "text", text: "five" } },
		{ seq: 6, role: "assistant", chunk: { type: "text", text: "six" } },
	];

	function appWithChunks(chunks: StoredChunk[]) {
		const store = new Map<string, StoredChunk[]>([["conv1", chunks]]);
		return createApp({
			conversationStore: createFakeConversationStore(store),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});
	}

	it("?limit=N returns only the newest N chunks, ascending, latestSeq = last seq", async () => {
		const app = appWithChunks(sixChunks);
		const res = await app.request("/conversations/conv1?limit=2");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		expect(body.chunks.map((c) => c.seq)).toEqual([5, 6]);
		expect(body.latestSeq).toBe(6);
	});

	it("?limit=N with N >= conversation size returns the full log", async () => {
		const app = appWithChunks(sixChunks);
		const res = await app.request("/conversations/conv1?limit=10");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		expect(body.chunks.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(body.latestSeq).toBe(6);
	});

	it("?beforeSeq=S returns only chunks with seq < S", async () => {
		const app = appWithChunks(sixChunks);
		const res = await app.request("/conversations/conv1?beforeSeq=3");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		expect(body.chunks.map((c) => c.seq)).toEqual([1, 2]);
		expect(body.latestSeq).toBe(2);
	});

	it("?beforeSeq=S&limit=N returns the newest N below S, ascending", async () => {
		const app = appWithChunks(sixChunks);
		const res = await app.request("/conversations/conv1?beforeSeq=5&limit=2");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		// selection = seq 1..4; newest 2 = [3, 4]
		expect(body.chunks.map((c) => c.seq)).toEqual([3, 4]);
		expect(body.latestSeq).toBe(4);
	});

	it("?sinceSeq=A&beforeSeq=B returns A < seq < B", async () => {
		const app = appWithChunks(sixChunks);
		const res = await app.request("/conversations/conv1?sinceSeq=2&beforeSeq=5");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		expect(body.chunks.map((c) => c.seq)).toEqual([3, 4]);
		expect(body.latestSeq).toBe(4);
	});

	describe("window param validation → 400 and store not called with an invalid window", () => {
		function appCapturingWindow() {
			const calls: {
				readonly sinceSeq: number | undefined;
				readonly window: { readonly beforeSeq?: number; readonly limit?: number } | undefined;
			}[] = [];
			const store: ConversationStore = {
				async append() {},
				async load() {
					return [];
				},
				async loadSince(_conversationId, sinceSeq, window) {
					calls.push({ sinceSeq, window });
					return [];
				},
				async appendMetrics() {},
				async loadMetrics() {
					return [];
				},
				async getCwd() {
					return null;
				},
				async setCwd() {},
				async clearCwd() {},
				async getReasoningEffort() {
					return null;
				},
				async setReasoningEffort() {},
				async listConversations() {
					return [];
				},
				async getConversationMeta() {
					return null;
				},
				async setConversationTitle() {},
				async getConversationStatus() {
					return null;
				},
				async setConversationStatus() {},
				async replaceHistory() {},
				async getCompactPercent() {
					return null;
				},
				async setCompactPercent() {},
				async forkHistory() {},
				async setCompactedFrom() {},
				async getWorkspace() {
					return null;
				},
				async ensureWorkspace() {
					return {
						id: "default",
						title: "default",
						defaultCwd: null,
						createdAt: 0,
						lastActivityAt: 0,
					};
				},
				async setWorkspaceTitle() {
					return {
						id: "default",
						title: "default",
						defaultCwd: null,
						createdAt: 0,
						lastActivityAt: 0,
					};
				},
				async setWorkspaceDefaultCwd() {
					return {
						id: "default",
						title: "default",
						defaultCwd: null,
						createdAt: 0,
						lastActivityAt: 0,
					};
				},
				async deleteWorkspace() {
					return { closedCount: 0 };
				},
				async listWorkspaces() {
					return [];
				},
				async getWorkspaceId() {
					return "default";
				},
				async setWorkspaceId() {},
				async getEffectiveCwd() {
					return null;
				},
			};
			const app = createApp({
				conversationStore: store,
				orchestrator: createFakeOrchestrator([]),
				credentialStore: createFakeCredentialStore([]),
			});
			return { app, calls };
		}

		const cases: readonly { readonly name: string; readonly query: string }[] = [
			{ name: "limit=0", query: "limit=0" },
			{ name: "limit=-1", query: "limit=-1" },
			{ name: "limit=abc", query: "limit=abc" },
			{ name: "beforeSeq=0", query: "beforeSeq=0" },
			{ name: "beforeSeq=1.5", query: "beforeSeq=1.5" },
		];

		for (const { name, query } of cases) {
			it(`${name} → 400 { error } and loadSince is never called`, async () => {
				const { app, calls } = appCapturingWindow();
				const res = await app.request(`/conversations/conv1?${query}`);
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error: string };
				expect(typeof body.error).toBe("string");
				expect(body.error.length).toBeGreaterThan(0);
				expect(calls).toHaveLength(0);
			});
		}
	});

	it("no params → byte-identical to the no-window read (regression guard)", async () => {
		// Rest-param spy: record how many args the route actually passes, so we
		// can prove the third (window) arg is OMITTED entirely — not merely
		// forwarded as undefined — preserving the existing two-arg call shape.
		const argCounts: number[] = [];
		const store: ConversationStore = {
			async append() {},
			async load() {
				return [];
			},
			loadSince(...args: Parameters<ConversationStore["loadSince"]>) {
				argCounts.push(args.length);
				const sinceSeq = args[1] ?? 0;
				return Promise.resolve(sampleChunks.filter((c) => c.seq > sinceSeq));
			},
			async appendMetrics() {},
			async loadMetrics() {
				return [];
			},
			async getCwd() {
				return null;
			},
			async setCwd() {},
			async clearCwd() {},
			async getReasoningEffort() {
				return null;
			},
			async setReasoningEffort() {},
			async listConversations() {
				return [];
			},
			async getConversationMeta() {
				return null;
			},
			async setConversationTitle() {},
			async getConversationStatus() {
				return null;
			},
			async setConversationStatus() {},
			async replaceHistory() {},
			async getCompactPercent() {
				return null;
			},
			async setCompactPercent() {},
			async forkHistory() {},
			async setCompactedFrom() {},
			async getWorkspace() {
				return null;
			},
			async ensureWorkspace() {
				return {
					id: "default",
					title: "default",
					defaultCwd: null,
					createdAt: 0,
					lastActivityAt: 0,
				};
			},
			async setWorkspaceTitle() {
				return {
					id: "default",
					title: "default",
					defaultCwd: null,
					createdAt: 0,
					lastActivityAt: 0,
				};
			},
			async setWorkspaceDefaultCwd() {
				return {
					id: "default",
					title: "default",
					defaultCwd: null,
					createdAt: 0,
					lastActivityAt: 0,
				};
			},
			async deleteWorkspace() {
				return { closedCount: 0 };
			},
			async listWorkspaces() {
				return [];
			},
			async getWorkspaceId() {
				return "default";
			},
			async setWorkspaceId() {},
			async getEffectiveCwd() {
				return null;
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/conversations/conv1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly StoredChunk[]; latestSeq: number };
		expect(body.chunks.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
		expect(body.latestSeq).toBe(4);
		// Called once, with exactly two arguments (no window arg).
		expect(argCounts).toEqual([2]);
	});
});

describe("GET /conversations/:id/metrics", () => {
	const sampleMetrics: TurnMetrics[] = [
		{
			turnId: "turn1",
			usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
			durationMs: 1000,
			steps: [
				{
					stepId: "step1" as StepId,
					usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
					ttftMs: 200,
					decodeMs: 300,
					genTotalMs: 500,
				},
			],
		},
		{
			turnId: "turn2",
			usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 10, cacheWriteTokens: 5 },
			durationMs: 1500,
			steps: [
				{
					stepId: "step2" as StepId,
					usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 10, cacheWriteTokens: 5 },
					ttftMs: 300,
					decodeMs: 500,
					genTotalMs: 800,
				},
			],
		},
	];

	it("returns persisted turn metrics as { turns }", async () => {
		const metricsStore = new Map<string, TurnMetrics[]>([["conv1", sampleMetrics]]);
		const app = createApp({
			conversationStore: createFakeConversationStore(new Map(), metricsStore),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/conversations/conv1/metrics");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { turns: readonly TurnMetrics[] };
		expect(body.turns).toHaveLength(2);
		expect(body.turns[0]?.turnId).toBe("turn1");
		expect(body.turns[1]?.turnId).toBe("turn2");
	});

	it("returns { turns: [] } for an unknown conversation", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/conversations/unknown/metrics");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { turns: readonly TurnMetrics[] };
		expect(body.turns).toHaveLength(0);
	});

	it("the metrics route does not collide with GET /conversations/:id history route", async () => {
		const sampleChunks: StoredChunk[] = [
			{ seq: 1, role: "user", chunk: { type: "text", text: "hello" } },
		];
		const store = new Map<string, StoredChunk[]>([["conv1", sampleChunks]]);
		const metricsStore = new Map<string, TurnMetrics[]>([["conv1", sampleMetrics]]);
		const app = createApp({
			conversationStore: createFakeConversationStore(store, metricsStore),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const metricsRes = await app.request("/conversations/conv1/metrics");
		expect(metricsRes.status).toBe(200);
		const metricsBody = (await metricsRes.json()) as { turns: readonly TurnMetrics[] };
		expect(metricsBody.turns).toHaveLength(2);

		const historyRes = await app.request("/conversations/conv1");
		expect(historyRes.status).toBe(200);
		const historyBody = (await historyRes.json()) as {
			chunks: readonly StoredChunk[];
			latestSeq: number;
		};
		expect(historyBody.chunks).toHaveLength(1);
	});

	it("a store failure on the metrics read returns an error status + logs an error", async () => {
		const logger = createFakeLogger();
		const brokenStore: ConversationStore = {
			async append() {},
			async load() {
				return [];
			},
			async loadSince() {
				return [];
			},
			async appendMetrics() {},
			async loadMetrics() {
				throw new Error("storage exploded");
			},
			async getCwd() {
				return null;
			},
			async setCwd() {},
			async clearCwd() {},
			async getReasoningEffort() {
				return null;
			},
			async setReasoningEffort() {},
			async listConversations() {
				return [];
			},
			async getConversationMeta() {
				return null;
			},
			async setConversationTitle() {},
			async getConversationStatus() {
				return null;
			},
			async setConversationStatus() {},
			async replaceHistory() {},
			async getCompactPercent() {
				return null;
			},
			async setCompactPercent() {},
			async forkHistory() {},
			async setCompactedFrom() {},
			async getWorkspace() {
				return null;
			},
			async ensureWorkspace() {
				return {
					id: "default",
					title: "default",
					defaultCwd: null,
					createdAt: 0,
					lastActivityAt: 0,
				};
			},
			async setWorkspaceTitle() {
				return {
					id: "default",
					title: "default",
					defaultCwd: null,
					createdAt: 0,
					lastActivityAt: 0,
				};
			},
			async setWorkspaceDefaultCwd() {
				return {
					id: "default",
					title: "default",
					defaultCwd: null,
					createdAt: 0,
					lastActivityAt: 0,
				};
			},
			async deleteWorkspace() {
				return { closedCount: 0 };
			},
			async listWorkspaces() {
				return [];
			},
			async getWorkspaceId() {
				return "default";
			},
			async setWorkspaceId() {},
			async getEffectiveCwd() {
				return null;
			},
		};
		const app = createApp({
			conversationStore: brokenStore,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger,
		});

		const res = await app.request("/conversations/conv1/metrics");
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Failed to load conversation metrics");

		const errorLogs = logger.records.filter((r) => r.level === "error");
		expect(errorLogs).toHaveLength(1);
		expect(errorLogs[0]?.msg).toBe("conversations: metrics store failure");
		expect(errorLogs[0]?.attrs?.err).toBeInstanceOf(Error);
	});
});

describe("POST /chat logging", () => {
	it("POST /chat logs an info line when a request is accepted", async () => {
		const logger = createFakeLogger();
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([
				{ type: "done", conversationId: "conv1", turnId: "turn1", reason: "stop" },
			]),
			credentialStore: createFakeCredentialStore([]),
			logger,
		});

		await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "hi",
				conversationId: "conv1",
				model: "opencode/m1",
				cwd: "/tmp",
			}),
		});

		const infoLogs = logger.records.filter((r) => r.level === "info");
		expect(infoLogs).toHaveLength(1);
		expect(infoLogs[0]?.msg).toBe("chat: request accepted");
		expect(infoLogs[0]?.attrs?.conversationId).toBe("conv1");
		expect(infoLogs[0]?.attrs?.hasModel).toBe(true);
		expect(infoLogs[0]?.attrs?.hasCwd).toBe(true);
	});

	it("POST /chat logs a warn on a malformed body (400)", async () => {
		const logger = createFakeLogger();
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger,
		});

		await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});

		const warnLogs = logger.records.filter((r) => r.level === "warn");
		expect(warnLogs.length).toBeGreaterThanOrEqual(1);
		expect(warnLogs[0]?.msg).toBe("chat: invalid JSON body");
	});

	it("POST /chat logs an error when the turn fails", async () => {
		const logger = createFakeLogger();
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createThrowingOrchestrator(new Error("boom")),
			credentialStore: createFakeCredentialStore([]),
			logger,
		});

		await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi", conversationId: "conv1" }),
		});

		const errorLogs = logger.records.filter((r) => r.level === "error");
		expect(errorLogs).toHaveLength(1);
		expect(errorLogs[0]?.msg).toBe("chat: turn failed");
		expect(errorLogs[0]?.attrs?.err).toBeInstanceOf(Error);
	});
});

describe("GET /conversations/:id logging", () => {
	it("GET /conversations/:id logs the read (conversationId + sinceSeq + count)", async () => {
		const logger = createFakeLogger();
		const sampleChunks: StoredChunk[] = [
			{ seq: 1, role: "user", chunk: { type: "text", text: "hello" } },
			{ seq: 2, role: "assistant", chunk: { type: "text", text: "hi there" } },
		];
		const store = new Map<string, StoredChunk[]>([["conv1", sampleChunks]]);
		const app = createApp({
			conversationStore: createFakeConversationStore(store),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger,
		});

		await app.request("/conversations/conv1?sinceSeq=0");

		const infoLogs = logger.records.filter((r) => r.level === "info");
		expect(infoLogs).toHaveLength(1);
		expect(infoLogs[0]?.msg).toBe("conversations: read");
		expect(infoLogs[0]?.attrs?.conversationId).toBe("conv1");
		expect(infoLogs[0]?.attrs?.sinceSeq).toBe(0);
		expect(infoLogs[0]?.attrs?.count).toBe(2);
	});
});

describe("CORS", () => {
	function createTestApp() {
		return createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([
				{ type: "done", conversationId: "conv1", turnId: "turn1", reason: "stop" },
			]),
			credentialStore: createFakeCredentialStore(["opencode/m1"]),
		});
	}

	it("POST /chat response carries Access-Control-Allow-Origin: *", async () => {
		const app = createTestApp();
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi", conversationId: "conv1" }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("GET /models response carries the CORS headers", async () => {
		const app = createTestApp();
		const res = await app.request("/models");
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(res.headers.get("Access-Control-Expose-Headers")).toBeDefined();
	});

	it("GET /conversations/:id response carries the CORS headers", async () => {
		const app = createTestApp();
		const res = await app.request("/conversations/conv1");
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(res.headers.get("Access-Control-Expose-Headers")).toBeDefined();
	});

	it("OPTIONS preflight for /chat returns 204 with Allow-Methods + Allow-Headers", async () => {
		const app = createTestApp();
		const res = await app.request("/chat", { method: "OPTIONS" });
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
	});
});

describe("throughput recording + GET /metrics/throughput", () => {
	const ts = new Date(2026, 5, 10, 12, 0, 0).getTime();
	const day = dayKeyOf(ts);

	function appWith(
		throughputStore: ReturnType<typeof createThroughputStore>,
		events: AgentEvent[],
	) {
		return createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator(events),
			credentialStore: createFakeCredentialStore([]),
			throughputStore,
			now: () => ts,
		});
	}

	async function postChat(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
		return app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("records a per-model sample from a turn and aggregates it (token-weighted tok/s)", async () => {
		const store = createThroughputStore({ storage: createMemStorage() });
		const events: AgentEvent[] = [
			{
				type: "step-complete",
				conversationId: "c1",
				turnId: "t1",
				stepId: "t1#0" as StepId,
				genTotalMs: 2000,
			},
			{
				type: "done",
				conversationId: "c1",
				turnId: "t1",
				reason: "stop",
				usage: { inputTokens: 10, outputTokens: 400 },
			},
		];
		const app = appWith(store, events);

		const chat = await postChat(app, {
			conversationId: "c1",
			message: "hi",
			model: "claude/haiku",
		});
		expect(chat.status).toBe(200);

		const res = await app.request(`/metrics/throughput?period=day&date=${day}`);
		expect(res.status).toBe(200);
		const report = (await res.json()) as ThroughputResponse;
		expect(report.period).toBe("day");
		expect(report.models).toHaveLength(1);
		expect(report.models[0]).toMatchObject({
			model: "claude/haiku",
			totalOutputTokens: 400,
			totalGenMs: 2000,
			tokensPerSecond: 200, // 400 tokens / 2s
			turns: 1,
		});
	});

	it("does not record a sample when no model is selected", async () => {
		const store = createThroughputStore({ storage: createMemStorage() });
		const events: AgentEvent[] = [
			{
				type: "step-complete",
				conversationId: "c1",
				turnId: "t1",
				stepId: "t1#0" as StepId,
				genTotalMs: 2000,
			},
			{
				type: "done",
				conversationId: "c1",
				turnId: "t1",
				reason: "stop",
				usage: { inputTokens: 1, outputTokens: 5 },
			},
		];
		const app = appWith(store, events);

		await postChat(app, { conversationId: "c1", message: "hi" }); // no model
		const res = await app.request(`/metrics/throughput?period=day&date=${day}`);
		const report = (await res.json()) as { models: unknown[] };
		expect(report.models).toEqual([]);
	});

	it("returns 400 for an invalid period", async () => {
		const app = appWith(createThroughputStore({ storage: createMemStorage() }), []);
		const res = await app.request("/metrics/throughput?period=year&date=2026");
		expect(res.status).toBe(400);
	});

	it("returns 400 for a malformed date", async () => {
		const app = appWith(createThroughputStore({ storage: createMemStorage() }), []);
		const res = await app.request("/metrics/throughput?period=day&date=nope");
		expect(res.status).toBe(400);
	});

	it("returns 400 when date is missing", async () => {
		const app = appWith(createThroughputStore({ storage: createMemStorage() }), []);
		const res = await app.request("/metrics/throughput?period=day");
		expect(res.status).toBe(400);
	});
});

describe("POST /conversations/:id/close", () => {
	it("closes via the orchestrator and returns CloseConversationResponse", async () => {
		const closeCalls: string[] = [];
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			closeConversation(conversationId) {
				closeCalls.push(conversationId);
				return { abortedTurn: true };
			},
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv-9/close", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ conversationId: "conv-9", abortedTurn: true });
		expect(closeCalls).toEqual(["conv-9"]);
	});

	it("reports abortedTurn false for an idle conversation", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv-idle/close", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ conversationId: "conv-idle", abortedTurn: false });
	});
});

describe("POST /conversations/:id/queue", () => {
	it("with valid text → 200 + QueueResponse (startedTurn + queue)", async () => {
		const queue: readonly QueuedMessage[] = [
			{ id: "q1", text: "queued-msg", queuedAt: 1700000000000 },
		];
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			enqueue() {
				return { startedTurn: false, queue };
			},
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as QueueResponse;
		expect(body.conversationId).toBe("conv1");
		expect(body.startedTurn).toBe(false);
		expect(body.queue).toEqual(queue);
	});

	it("with empty/whitespace text → 400 { error } and enqueue is never called", async () => {
		let enqueueCalled = false;
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			enqueue() {
				enqueueCalled = true;
				return { startedTurn: false, queue: [] };
			},
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "   " }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("text");
		expect(enqueueCalled).toBe(false);
	});

	it("with missing text field → 400 { error } and enqueue is never called", async () => {
		let enqueueCalled = false;
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			enqueue() {
				enqueueCalled = true;
				return { startedTurn: false, queue: [] };
			},
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("text");
		expect(enqueueCalled).toBe(false);
	});

	it("enqueue returns startedTurn:true (was idle) → response echoes it", async () => {
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			enqueue() {
				return { startedTurn: true, queue: [] };
			},
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv-idle/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "go" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as QueueResponse;
		expect(body.conversationId).toBe("conv-idle");
		expect(body.startedTurn).toBe(true);
		expect(body.queue).toEqual([]);
	});

	it("enqueue returns startedTurn:false (was active) → response carries the queue snapshot", async () => {
		const queue: readonly QueuedMessage[] = [
			{ id: "q1", text: "second", queuedAt: 1700000000000 },
			{ id: "q2", text: "third", queuedAt: 1700000001000 },
		];
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			enqueue() {
				return { startedTurn: false, queue };
			},
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv-active/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "steer" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as QueueResponse;
		expect(body.conversationId).toBe("conv-active");
		expect(body.startedTurn).toBe(false);
		expect(body.queue).toEqual(queue);
	});

	it("forwards the path conversationId and trimmed text to enqueue", async () => {
		const calls: { conversationId: string; text: string }[] = [];
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			enqueue(input) {
				calls.push(input);
				return { startedTurn: false, queue: [] };
			},
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv-1/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "  hello world  " }),
		});

		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.conversationId).toBe("conv-1");
		expect(calls[0]?.text).toBe("hello world");
	});

	it("returns 400 for invalid JSON body", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("JSON");
	});

	it("returns 400 for a non-string text", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: 42 }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("text");
	});

	it("logs an info line on success and never logs the enqueued text", async () => {
		const logger = createFakeLogger();
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			enqueue() {
				return { startedTurn: true, queue: [] };
			},
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
			logger,
		});

		await app.request("/conversations/conv1/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "secret-ish user message" }),
		});

		const infoLogs = logger.records.filter((r) => r.level === "info");
		expect(infoLogs).toHaveLength(1);
		expect(infoLogs[0]?.msg).toBe("conversations: enqueued");
		expect(infoLogs[0]?.attrs?.conversationId).toBe("conv1");
		expect(infoLogs[0]?.attrs?.startedTurn).toBe(true);
		expect(infoLogs[0]?.attrs?.queueLength).toBe(0);
		// Restraint: the user's message text is never logged (mirrors POST /chat).
		expect(JSON.stringify(logger.records)).not.toContain("secret-ish user message");
	});

	it("logs a warn on a malformed body (400)", async () => {
		const logger = createFakeLogger();
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger,
		});

		await app.request("/conversations/conv1/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "" }),
		});

		const warnLogs = logger.records.filter((r) => r.level === "warn");
		expect(warnLogs.length).toBeGreaterThanOrEqual(1);
		expect(warnLogs[0]?.msg).toBe("conversations/queue: validation failed");
	});
});

describe("GET /conversations/:id/cwd", () => {
	it("returns null when unset", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/cwd");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; cwd: string | null };
		expect(body.conversationId).toBe("conv1");
		expect(body.cwd).toBeNull();
	});
});

describe("PUT then GET /conversations/:id/cwd", () => {
	it("round-trips the value", async () => {
		const store = createFakeConversationStore();
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const putRes = await app.request("/conversations/conv1/cwd", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: "/home/user/project" }),
		});
		expect(putRes.status).toBe(200);
		const putBody = (await putRes.json()) as { conversationId: string; cwd: string };
		expect(putBody.conversationId).toBe("conv1");
		expect(putBody.cwd).toBe("/home/user/project");

		const getRes = await app.request("/conversations/conv1/cwd");
		expect(getRes.status).toBe(200);
		const getBody = (await getRes.json()) as { conversationId: string; cwd: string | null };
		expect(getBody.cwd).toBe("/home/user/project");
	});
});

describe("DELETE /conversations/:id/cwd", () => {
	it("after a PUT cwd → returns { cwd: null } and a subsequent GET returns cwd: null", async () => {
		const store = createFakeConversationStore();
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const putRes = await app.request("/conversations/conv1/cwd", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: "/home/user/project" }),
		});
		expect(putRes.status).toBe(200);

		const deleteRes = await app.request("/conversations/conv1/cwd", { method: "DELETE" });
		expect(deleteRes.status).toBe(200);
		const deleteBody = (await deleteRes.json()) as { conversationId: string; cwd: string | null };
		expect(deleteBody.conversationId).toBe("conv1");
		expect(deleteBody.cwd).toBeNull();

		const getRes = await app.request("/conversations/conv1/cwd");
		expect(getRes.status).toBe(200);
		const getBody = (await getRes.json()) as { conversationId: string; cwd: string | null };
		expect(getBody.cwd).toBeNull();
	});

	it("on a conversation that never had a cwd set → returns { cwd: null }, no error (idempotent)", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const deleteRes = await app.request("/conversations/conv1/cwd", { method: "DELETE" });
		expect(deleteRes.status).toBe(200);
		const deleteBody = (await deleteRes.json()) as { conversationId: string; cwd: string | null };
		expect(deleteBody.conversationId).toBe("conv1");
		expect(deleteBody.cwd).toBeNull();
	});

	it("does NOT affect other conversations' cwds (isolation)", async () => {
		const cwdStore = new Map<string, string>([
			["conv1", "/home/user/project"],
			["conv2", "/other/path"],
		]);
		const store = createFakeConversationStore(new Map(), new Map(), cwdStore);
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const deleteRes = await app.request("/conversations/conv1/cwd", { method: "DELETE" });
		expect(deleteRes.status).toBe(200);

		const get1Res = await app.request("/conversations/conv1/cwd");
		expect(get1Res.status).toBe(200);
		const get1Body = (await get1Res.json()) as { conversationId: string; cwd: string | null };
		expect(get1Body.cwd).toBeNull();

		const get2Res = await app.request("/conversations/conv2/cwd");
		expect(get2Res.status).toBe(200);
		const get2Body = (await get2Res.json()) as { conversationId: string; cwd: string | null };
		expect(get2Body.cwd).toBe("/other/path");
	});
});

describe("PUT /conversations/:id/cwd", () => {
	it("with missing cwd returns 400", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/cwd", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("cwd");
	});

	it("with empty cwd returns 400", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/cwd", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("PUT cwd with workspaceId: assigns workspace before setCwd", async () => {
		const base = createFakeConversationStore();
		const store = createCallTrackingStore(base);
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/cwd", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: "/home/user/project", workspaceId: "my-team" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; cwd: string };
		expect(body.cwd).toBe("/home/user/project");
		// ensureWorkspace + setWorkspaceId called (in that order) BEFORE setCwd.
		expect(store.calls).toEqual([
			"ensureWorkspace:my-team",
			"setWorkspaceId:my-team",
			"setCwd:/home/user/project",
		]);
	});

	it("PUT cwd without workspaceId: only setCwd", async () => {
		const base = createFakeConversationStore();
		const store = createCallTrackingStore(base);
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/cwd", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: "/home/user/project" }),
		});
		expect(res.status).toBe(200);
		// ensureWorkspace and setWorkspaceId NOT called.
		expect(store.calls).toEqual(["setCwd:/home/user/project"]);
	});

	it("PUT cwd with invalid workspaceId: returns 400", async () => {
		const base = createFakeConversationStore();
		const store = createCallTrackingStore(base);
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		// Uppercase is not a valid workspace slug.
		const res = await app.request("/conversations/conv1/cwd", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: "/home/user/project", workspaceId: "UPPER" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Invalid workspaceId");
		// No mutating calls should have been made.
		expect(store.calls).toEqual([]);

		// Empty string is also invalid.
		const res2 = await app.request("/conversations/conv1/cwd", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: "/home/user/project", workspaceId: "" }),
		});
		expect(res2.status).toBe(400);
	});
});

describe("GET /conversations/:id/lsp", () => {
	it("returns empty servers when cwd is unset", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			lspService: createFakeLspService(),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/lsp");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			conversationId: string;
			cwd: string | null;
			servers: readonly unknown[];
		};
		expect(body.conversationId).toBe("conv1");
		expect(body.cwd).toBeNull();
		expect(body.servers).toEqual([]);
	});

	it("maps the lsp service statuses to LspServerInfo[] when cwd is set", async () => {
		const cwdStore = new Map<string, string>([["conv1", "/home/user/project"]]);
		const store = createFakeConversationStore(new Map(), new Map(), cwdStore);
		const lspStatuses = [
			{
				id: "typescript",
				name: "TypeScript",
				root: "/home/user/project",
				extensions: [".ts", ".tsx"],
				state: "connected" as const,
			},
			{
				id: "lua-lsp",
				name: "Lua LSP",
				root: "/home/user/project",
				extensions: [".luau"],
				state: "error" as const,
				error: "spawn failed",
			},
		];
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			lspService: createFakeLspService(lspStatuses),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/lsp");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			conversationId: string;
			cwd: string | null;
			servers: readonly {
				readonly id: string;
				readonly name: string;
				readonly root: string;
				readonly extensions: readonly string[];
				readonly state: string;
				readonly error?: string;
			}[];
		};
		expect(body.conversationId).toBe("conv1");
		expect(body.cwd).toBe("/home/user/project");
		expect(body.servers).toHaveLength(2);
		expect(body.servers[0]?.id).toBe("typescript");
		expect(body.servers[0]?.state).toBe("connected");
		expect(body.servers[0]?.error).toBeUndefined();
		expect(body.servers[1]?.id).toBe("lua-lsp");
		expect(body.servers[1]?.state).toBe("error");
		expect(body.servers[1]?.error).toBe("spawn failed");
	});

	it("LSP: returns null+empty when no persisted cwd — lspService.status NOT called", async () => {
		const cwdStore = new Map<string, string>(); // no persisted cwd
		const store = createFakeConversationStore(new Map(), new Map(), cwdStore);
		const lsp = createCapturingLspService([
			{
				id: "typescript",
				name: "TypeScript",
				root: "/irrelevant",
				extensions: [".ts"],
				state: "connected" as const,
			},
		]);
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			lspService: lsp,
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/lsp");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			conversationId: string;
			cwd: string | null;
			servers: readonly unknown[];
		};
		expect(body.conversationId).toBe("conv1");
		expect(body.cwd).toBeNull();
		expect(body.servers).toEqual([]);
		expect(lsp.statusCalls).toEqual([]); // status NOT called
	});

	it("LSP: uses effectiveCwd when persisted cwd is set — status called with resolved cwd", async () => {
		// Persisted (relative) cwd differs from the resolved effective cwd.
		const cwdStore = new Map<string, string>([["conv1", "subdir"]]);
		const store = createFakeConversationStore(new Map(), new Map(), cwdStore);
		// Override getEffectiveCwd to return the resolved (absolute) value.
		const resolvedStore: ConversationStore = {
			...store,
			async getEffectiveCwd() {
				return "/workspace/subdir";
			},
		};
		const lsp = createCapturingLspService([
			{
				id: "typescript",
				name: "TypeScript",
				root: "/workspace/subdir",
				extensions: [".ts", ".tsx"],
				state: "connected" as const,
			},
		]);
		const app = createApp({
			conversationStore: resolvedStore,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			lspService: lsp,
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/lsp");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			conversationId: string;
			cwd: string | null;
			servers: readonly { readonly id: string }[];
		};
		expect(body.conversationId).toBe("conv1");
		expect(body.cwd).toBe("/workspace/subdir"); // effective, not persisted
		expect(lsp.statusCalls).toEqual(["/workspace/subdir"]);
		expect(body.servers).toHaveLength(1);
		expect(body.servers[0]?.id).toBe("typescript");
	});
});

describe("POST /chat reasoningEffort", () => {
	const allLevels: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

	for (const level of allLevels) {
		it(`forwards reasoningEffort="${level}" to orchestrator`, async () => {
			const cap = createCapturingOrchestrator();
			const app = createApp({
				conversationStore: createFakeConversationStore(),
				orchestrator: cap,
				credentialStore: createFakeCredentialStore([]),
			});

			const res = await app.request("/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: "hi",
					conversationId: "conv1",
					reasoningEffort: level,
				}),
			});

			expect(res.status).toBe(200);
			expect(cap.received).toBeDefined();
			expect(cap.received?.reasoningEffort).toBe(level);
		});
	}

	it("omits reasoningEffort from orchestrator input when not provided", async () => {
		const cap = createCapturingOrchestrator();
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: cap,
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi", conversationId: "conv1" }),
		});

		expect(res.status).toBe(200);
		expect(cap.received).toBeDefined();
		expect(cap.received?.reasoningEffort).toBeUndefined();
	});

	it("returns 400 for invalid reasoningEffort and does not call orchestrator", async () => {
		let handleMessageCalled = false;
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			async handleMessage(input) {
				handleMessageCalled = true;
				return createFakeOrchestrator([]).handleMessage(input);
			},
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "hi",
				conversationId: "conv1",
				reasoningEffort: "banana",
			}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("reasoningEffort");
		expect(handleMessageCalled).toBe(false);
	});

	it("returns 400 for non-string reasoningEffort", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "hi",
				conversationId: "conv1",
				reasoningEffort: 42,
			}),
		});

		expect(res.status).toBe(400);
	});
});

describe("GET /conversations/:id/reasoning-effort", () => {
	it("returns null when never set", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/reasoning-effort");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; reasoningEffort: string | null };
		expect(body.conversationId).toBe("conv1");
		expect(body.reasoningEffort).toBeNull();
	});

	it("returns the level after PUT", async () => {
		const store = createFakeConversationStore();
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		await app.request("/conversations/conv1/reasoning-effort", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reasoningEffort: "xhigh" }),
		});

		const res = await app.request("/conversations/conv1/reasoning-effort");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; reasoningEffort: string | null };
		expect(body.reasoningEffort).toBe("xhigh");
	});

	it("returns null for an unknown conversation", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/unknown/reasoning-effort");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; reasoningEffort: string | null };
		expect(body.conversationId).toBe("unknown");
		expect(body.reasoningEffort).toBeNull();
	});
});

describe("PUT /conversations/:id/reasoning-effort", () => {
	it("persists a valid level and returns it", async () => {
		const store = createFakeConversationStore();
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/reasoning-effort", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reasoningEffort: "low" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; reasoningEffort: string };
		expect(body.conversationId).toBe("conv1");
		expect(body.reasoningEffort).toBe("low");
	});

	it("returns 400 for an invalid level", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/reasoning-effort", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reasoningEffort: "banana" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("reasoningEffort");
	});

	it("returns 400 when reasoningEffort is missing from body", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/reasoning-effort", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 for invalid JSON body", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/reasoning-effort", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	it("does not call store on validation failure", async () => {
		let storeCalled = false;
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async setReasoningEffort() {
				storeCalled = true;
			},
			async listConversations() {
				return [];
			},
			async getConversationMeta() {
				return null;
			},
			async setConversationTitle() {},
			async getConversationStatus() {
				return null;
			},
			async setConversationStatus() {},
			async replaceHistory() {},
			async getCompactPercent() {
				return null;
			},
			async setCompactPercent() {},
			async forkHistory() {},
			async setCompactedFrom() {},
			async getWorkspace() {
				return null;
			},
			async ensureWorkspace() {
				return {
					id: "default",
					title: "default",
					defaultCwd: null,
					createdAt: 0,
					lastActivityAt: 0,
				};
			},
			async setWorkspaceTitle() {
				return {
					id: "default",
					title: "default",
					defaultCwd: null,
					createdAt: 0,
					lastActivityAt: 0,
				};
			},
			async setWorkspaceDefaultCwd() {
				return {
					id: "default",
					title: "default",
					defaultCwd: null,
					createdAt: 0,
					lastActivityAt: 0,
				};
			},
			async deleteWorkspace() {
				return { closedCount: 0 };
			},
			async listWorkspaces() {
				return [];
			},
			async getWorkspaceId() {
				return "default";
			},
			async setWorkspaceId() {},
			async getEffectiveCwd() {
				return null;
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/reasoning-effort", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reasoningEffort: "invalid" }),
		});
		expect(res.status).toBe(400);
		expect(storeCalled).toBe(false);
	});
});

describe("GET /conversations", () => {
	const sampleConvos: ConversationMeta[] = [
		{
			id: "conv-1",
			createdAt: 1000,
			lastActivityAt: 2000,
			title: "First",
			status: "idle",
			workspaceId: "default",
		},
		{
			id: "conv-2",
			createdAt: 1500,
			lastActivityAt: 2500,
			title: "Second",
			status: "idle",
			workspaceId: "default",
		},
		{
			id: "other-1",
			createdAt: 3000,
			lastActivityAt: 4000,
			title: "Other",
			status: "idle",
			workspaceId: "default",
		},
	];

	function appWithList(list: ConversationMeta[]) {
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async listConversations() {
				return list;
			},
		};
		return createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
	}

	it("returns 200 with list", async () => {
		const app = appWithList(sampleConvos);
		const res = await app.request("/conversations");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversations: ConversationMeta[] };
		expect(body.conversations).toHaveLength(3);
		expect(body.conversations.map((c) => c.id)).toEqual(["conv-1", "conv-2", "other-1"]);
	});

	it("?q= filters by id prefix", async () => {
		const app = appWithList(sampleConvos);
		const res = await app.request("/conversations?q=conv-");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversations: ConversationMeta[] };
		expect(body.conversations).toHaveLength(2);
		expect(body.conversations.map((c) => c.id)).toEqual(["conv-1", "conv-2"]);
	});

	it("?q= returns all when q is empty", async () => {
		const app = appWithList(sampleConvos);
		const res = await app.request("/conversations?q=");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversations: ConversationMeta[] };
		expect(body.conversations).toHaveLength(3);
	});

	it("?q= with whitespace-only returns all (trimmed to empty)", async () => {
		const app = appWithList(sampleConvos);
		const res = await app.request("/conversations?q=%20%20%20");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversations: ConversationMeta[] };
		expect(body.conversations).toHaveLength(3);
	});

	it("returns 500 when listConversations throws", async () => {
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async listConversations() {
				throw new Error("db down");
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations");
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Failed to list conversations");
	});
});

describe("GET /conversations/:id/last", () => {
	function appWithMessages(messagesByConv: Map<string, ChatMessage[]>) {
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async load(conversationId) {
				return messagesByConv.get(conversationId) ?? [];
			},
		};
		return createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
	}

	it("returns last assistant text", async () => {
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "hello" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "hi there" }] },
			{ role: "user", chunks: [{ type: "text", text: "more" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "final reply" }] },
		];
		const app = appWithMessages(new Map([["conv1", messages]]));
		const res = await app.request("/conversations/conv1/last");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; content: string; turnId?: string };
		expect(body.conversationId).toBe("conv1");
		expect(body.content).toBe("final reply");
		expect(body.turnId).toBeUndefined();
	});

	it("returns empty content for unknown conversation", async () => {
		const app = appWithMessages(new Map());
		const res = await app.request("/conversations/unknown/last");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; content: string; turnId?: string };
		expect(body.conversationId).toBe("unknown");
		expect(body.content).toBe("");
		expect(body.turnId).toBeUndefined();
	});

	it("blocks until turn settles", async () => {
		const turnId = "sealed-turn";
		const orchestrator: SessionOrchestrator = {
			...createFakeOrchestrator([]),
			subscribe(conversationId, listener) {
				const event = { type: "turn-sealed" as const, conversationId, turnId };
				setTimeout(() => listener(event), 0);
				return () => {};
			},
			isActive() {
				return true;
			},
		};
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "hello" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "after seal" }] },
		];
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async load() {
				return messages;
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator,
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});

		const res = await app.request("/conversations/conv1/last");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; content: string; turnId?: string };
		expect(body.conversationId).toBe("conv1");
		expect(body.content).toBe("after seal");
		expect(body.turnId).toBe(turnId);
	});
});

describe("POST /conversations/:id/open", () => {
	it("returns 200", async () => {
		const emit: HostAPI["emit"] = () => {};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			emit,
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/open", { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string };
		expect(body.conversationId).toBe("conv1");
	});

	it("calls emit with conversationOpened", async () => {
		const emitCalls: Array<{ readonly hook: unknown; readonly payload: unknown }> = [];
		const emit: HostAPI["emit"] = (hook, payload) => {
			emitCalls.push({ hook, payload });
		};
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			emit,
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/open", { method: "POST" });
		expect(res.status).toBe(200);
		expect(emitCalls).toHaveLength(1);
		expect(emitCalls[0]?.hook).toBe(conversationOpened);
		expect(emitCalls[0]?.payload).toEqual({ conversationId: "conv1" });
	});

	it("returns 500 when emit is absent", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/open", { method: "POST" });
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("not available");
	});
});

describe("PUT /conversations/:id/title", () => {
	it("returns 200 with title", async () => {
		const store = createFakeConversationStore();
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/title", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "My Conversation" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; title: string };
		expect(body.conversationId).toBe("conv1");
		expect(body.title).toBe("My Conversation");
	});

	it("rejects empty title with 400", async () => {
		let setTitleCalled = false;
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async setConversationTitle() {
				setTitleCalled = true;
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/title", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "   " }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("title");
		expect(setTitleCalled).toBe(false);
	});

	it("returns 400 when title is missing", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/title", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("title");
	});

	it("forwards the trimmed title to setConversationTitle", async () => {
		const calls: { conversationId: string; title: string }[] = [];
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async setConversationTitle(conversationId, title) {
				calls.push({ conversationId, title });
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/title", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "  trimmed title  " }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; title: string };
		expect(body.title).toBe("trimmed title");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.conversationId).toBe("conv1");
		expect(calls[0]?.title).toBe("trimmed title");
	});

	it("returns 400 for invalid JSON body", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/conversations/conv1/title", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("JSON");
	});
});

describe("extractLastAssistantText", () => {
	it("returns last assistant text chunk", () => {
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "hello" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "hi there" }] },
			{ role: "user", chunks: [{ type: "text", text: "how are you?" }] },
			{ role: "assistant", chunks: [{ type: "text", text: "I'm good!" }] },
		];
		expect(extractLastAssistantText(messages)).toBe("I'm good!");
	});

	it("returns empty string when no assistant message", () => {
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "hello" }] },
			{ role: "system", chunks: [{ type: "text", text: "system prompt" }] },
		];
		expect(extractLastAssistantText(messages)).toBe("");
	});

	it("returns the LAST text chunk when an assistant message has multiple", () => {
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "hello" }] },
			{
				role: "assistant",
				chunks: [
					{ type: "text", text: "first" },
					{ type: "thinking", text: "internal reasoning" },
					{ type: "text", text: "second" },
				],
			},
		];
		expect(extractLastAssistantText(messages)).toBe("second");
	});

	it("returns empty string when the last assistant message has no text chunk", () => {
		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "hello" }] },
			{
				role: "assistant",
				chunks: [
					{
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "read_file",
						input: { path: "/tmp" },
					},
				],
			},
		];
		expect(extractLastAssistantText(messages)).toBe("");
	});

	it("returns empty string for an empty message list", () => {
		expect(extractLastAssistantText([])).toBe("");
	});
});

describe("Workspaces", () => {
	const sampleWorkspace: Workspace = {
		id: "proj",
		title: "proj",
		defaultCwd: null,
		createdAt: 1000,
		lastActivityAt: 2000,
	};

	it("GET /workspaces returns list", async () => {
		const workspaceEntries = [{ ...sampleWorkspace, conversationCount: 1 }];
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async listWorkspaces() {
				return workspaceEntries;
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/workspaces");
		expect(res.status).toBe(200);
		const body = (await res.json()) as WorkspaceListResponse;
		expect(body.workspaces).toEqual(workspaceEntries);
	});

	it("PUT /workspaces/:id creates on miss", async () => {
		let ensured = false;
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async ensureWorkspace(id, opts) {
				ensured = true;
				return { ...sampleWorkspace, id, ...opts };
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/workspaces/proj", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Project", defaultCwd: "/home/proj" }),
		});
		expect(res.status).toBe(200);
		expect(ensured).toBe(true);
		const body = (await res.json()) as WorkspaceResponse;
		expect(body.id).toBe("proj");
		expect(body.title).toBe("Project");
		expect(body.defaultCwd).toBe("/home/proj");
	});

	it("PUT /workspaces/:id returns existing", async () => {
		const existing: Workspace = { ...sampleWorkspace, title: "Existing", defaultCwd: "/old" };
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async ensureWorkspace() {
				return existing;
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/workspaces/proj", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "New Title" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as WorkspaceResponse;
		expect(body.title).toBe("Existing");
		expect(body.defaultCwd).toBe("/old");
	});

	it("PUT /workspaces/:id rejects invalid slug", async () => {
		let ensured = false;
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async ensureWorkspace() {
				ensured = true;
				return sampleWorkspace;
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/workspaces/Bad Slug!", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(ensured).toBe(false);
	});

	it("GET /workspaces/:id returns 404 for missing", async () => {
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async getWorkspace() {
				return null;
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/workspaces/unknown");
		expect(res.status).toBe(404);
	});

	it("PUT /workspaces/:id/title renames", async () => {
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async setWorkspaceTitle(id, title) {
				return { ...sampleWorkspace, id, title };
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/workspaces/proj/title", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Renamed" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as WorkspaceResponse;
		expect(body.title).toBe("Renamed");
	});

	it("PUT /workspaces/:id/default-cwd sets", async () => {
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async setWorkspaceDefaultCwd(id, defaultCwd) {
				return { ...sampleWorkspace, id, defaultCwd };
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/workspaces/proj/default-cwd", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ defaultCwd: "/new/cwd" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as WorkspaceResponse;
		expect(body.defaultCwd).toBe("/new/cwd");
	});

	it("DELETE /workspaces/:id closes conversations", async () => {
		const store: ConversationStore = {
			...createFakeConversationStore(),
			async deleteWorkspace() {
				return { closedCount: 3 };
			},
		};
		const app = createApp({
			conversationStore: store,
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/workspaces/proj", { method: "DELETE" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as DeleteWorkspaceResponse;
		expect(body.workspaceId).toBe("proj");
		expect(body.closedCount).toBe(3);
	});

	it("DELETE /workspaces/default returns 409", async () => {
		const app = createApp({
			conversationStore: createFakeConversationStore(),
			orchestrator: createFakeOrchestrator([]),
			credentialStore: createFakeCredentialStore([]),
			logger: noopLogger,
		});
		const res = await app.request("/workspaces/default", { method: "DELETE" });
		expect(res.status).toBe(409);
	});
});

it("POST /chat threads workspaceId", async () => {
	const cap = createCapturingOrchestrator();
	const app = createApp({
		conversationStore: createFakeConversationStore(),
		orchestrator: cap,
		credentialStore: createFakeCredentialStore([]),
	});
	const res = await app.request("/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message: "hi", conversationId: "conv1", workspaceId: "proj" }),
	});
	expect(res.status).toBe(200);
	expect(cap.received).toBeDefined();
	expect(cap.received?.workspaceId).toBe("proj");
});

it("GET /conversations?workspaceId= filters", async () => {
	const calls: Parameters<ConversationStore["listConversations"]>[0][] = [];
	const store: ConversationStore = {
		...createFakeConversationStore(),
		async listConversations(filter) {
			calls.push(filter);
			return [];
		},
	};
	const app = createApp({
		conversationStore: store,
		orchestrator: createFakeOrchestrator([]),
		credentialStore: createFakeCredentialStore([]),
		logger: noopLogger,
	});
	const res = await app.request("/conversations?workspaceId=proj");
	expect(res.status).toBe(200);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toEqual({ workspaceId: "proj" });
});

it("GET /conversations/:id/lsp uses effective cwd", async () => {
	let effectiveCwdCalled = false;
	let getCwdCalled = false;
	let lspCwd: string | null = null;
	const store: ConversationStore = {
		...createFakeConversationStore(),
		async getEffectiveCwd(_conversationId) {
			effectiveCwdCalled = true;
			return "/effective";
		},
		async getCwd(_conversationId) {
			getCwdCalled = true;
			return "/explicit";
		},
	};
	const lsp: LspService = {
		async status(cwd) {
			lspCwd = cwd;
			return [];
		},
	};
	const app = createApp({
		conversationStore: store,
		orchestrator: createFakeOrchestrator([]),
		credentialStore: createFakeCredentialStore([]),
		lspService: lsp,
		logger: noopLogger,
	});
	const res = await app.request("/conversations/conv1/lsp");
	expect(res.status).toBe(200);
	expect(effectiveCwdCalled).toBe(true);
	expect(getCwdCalled).toBe(true); // gated on persisted cwd first
	expect(lspCwd).toBe("/effective");
	const body = (await res.json()) as {
		conversationId: string;
		cwd: string | null;
		servers: readonly unknown[];
	};
	expect(body.cwd).toBe("/effective");
});
