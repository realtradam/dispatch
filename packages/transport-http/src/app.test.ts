import type { AgentEvent, Logger, StoredChunk } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ConversationStore, CredentialStore, SessionOrchestrator } from "./seam.js";

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
): ConversationStore {
	return {
		async append() {},
		async load() {
			return [];
		},
		async loadSince(conversationId, sinceSeq) {
			const chunks = store.get(conversationId) ?? [];
			const minSeq = sinceSeq ?? 0;
			return chunks.filter((c) => c.seq > minSeq);
		},
	};
}

function createFakeOrchestrator(events: AgentEvent[]): SessionOrchestrator {
	return {
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
		async handleMessage(input) {
			state.received = input;
		},
	};
}

function createThrowingOrchestrator(error: Error): SessionOrchestrator {
	return {
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
		async listCatalog() {
			throw error;
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
