import { afterEach, describe, expect, test } from "bun:test";
import type { ConfigAccess, HostAPI, Logger } from "@dispatch/kernel";
import { createApp } from "./app.js";
import { createTransportHttpExtension } from "./index.js";
import type {
	ConversationStore,
	CredentialStore,
	LspService,
	SessionOrchestrator,
} from "./seam.js";

function fakeLogger(): Logger {
	return {
		debug() {},
		info() {},
		warn() {},
		error() {},
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

function fakeConversationStore(): ConversationStore {
	return {
		async append() {},
		async load() {
			return [];
		},
		async loadSince() {
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
		async getCompactThreshold() {
			return null;
		},
		async setCompactThreshold() {},
	};
}

function fakeOrchestrator(): SessionOrchestrator {
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
		async handleMessage() {},
	};
}

function fakeCredentialStore(): CredentialStore {
	return {
		resolve() {
			return undefined;
		},
		async listCatalog() {
			return [];
		},
	};
}

function fakeLspService(): LspService {
	return {
		async status() {
			return [];
		},
	};
}

function fakeConfig(overrides: Record<string, unknown> = {}): ConfigAccess {
	return {
		get<T>(key: string): T | undefined {
			return overrides[key] as T | undefined;
		},
		getAll() {
			return overrides;
		},
	};
}

const SERVICES = new Map<string, unknown>([
	["conversation-store/store", fakeConversationStore()],
	["session-orchestrator/orchestrator", fakeOrchestrator()],
	["credential-store/registry", fakeCredentialStore()],
	["lsp", fakeLspService()],
]);

function createFakeHostAPI(configOverrides: Record<string, unknown> = {}): HostAPI {
	return {
		defineTool() {},
		defineProvider() {},
		defineAuth() {},
		on() {
			return () => {};
		},
		emit() {},
		addFilter() {
			return () => {};
		},
		async applyFilters(_hook, value) {
			return value;
		},
		provideService() {},
		getService(handle) {
			return SERVICES.get(handle.id) as never;
		},
		storage() {
			return {
				get: async () => null,
				set: async () => {},
				delete: async () => {},
				has: async () => false,
				keys: async () => [],
			};
		},
		config: fakeConfig(configOverrides),
		secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
		permissions: { check: async () => ({ allowed: true }) },
		events: { emit() {} },
		logger: fakeLogger(),
		getProviders() {
			return new Map();
		},
		getTools() {
			return new Map();
		},
		getAuthProviders() {
			return new Map();
		},
		getAuthProvider() {
			return undefined;
		},
		getExtensions() {
			return [];
		},
		scheduler: { register() {} },
	};
}

// ── Server helper (mirrors extension.ts logic for direct testing) ────────

function startServer(port = 0) {
	const app = createApp({
		conversationStore: fakeConversationStore(),
		orchestrator: fakeOrchestrator(),
		credentialStore: fakeCredentialStore(),
	});
	return Bun.serve({ port, fetch: app.fetch });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("serves HTTP on the configured port", () => {
	let server: ReturnType<typeof Bun.serve>;
	let port: number;

	afterEach(() => {
		server.stop();
	});

	test("GET /health returns 200", async () => {
		server = startServer();
		port = server.port as number;

		const res = await fetch(`http://localhost:${port}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("POST /chat returns NDJSON", async () => {
		server = startServer();
		port = server.port as number;

		const res = await fetch(`http://localhost:${port}/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi", conversationId: "conv1" }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
	});

	test("GET /models returns 200", async () => {
		server = startServer();
		port = server.port as number;

		const res = await fetch(`http://localhost:${port}/models`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { models: readonly string[] };
		expect(body.models).toEqual([]);
	});

	test("GET /conversations/:id returns 200", async () => {
		server = startServer();
		port = server.port as number;

		const res = await fetch(`http://localhost:${port}/conversations/conv1`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { chunks: readonly unknown[]; latestSeq: number };
		expect(body.chunks).toEqual([]);
		expect(body.latestSeq).toBe(0);
	});
});

describe("extension lifecycle", () => {
	test("activate starts server on config port and deactivate stops it", async () => {
		const ext = createTransportHttpExtension();
		const host = createFakeHostAPI({ httpPort: 0 });
		await ext.activate(host);
		const server = ext._testServer;
		expect(server).toBeDefined();
		const port = server?.port as number;
		expect(port).toBeGreaterThan(0);

		const res = await fetch(`http://localhost:${port}/health`);
		expect(res.status).toBe(200);

		ext.deactivate?.();

		try {
			await fetch(`http://localhost:${port}/health`);
			expect(true).toBe(false);
		} catch {
			// expected — server stopped
		}
	});
});
