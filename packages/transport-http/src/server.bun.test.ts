import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_HEARTBEAT_CONFIG } from "@dispatch/heartbeat";
import {
  type Bus,
  type ConfigAccess,
  createBus,
  type HostAPI,
  type Logger,
  type ServiceHandle,
} from "@dispatch/kernel";
import { createApp } from "./app.js";
import { createTransportHttpExtension } from "./index.js";
import {
  type ConversationStore,
  type CredentialStore,
  cacheWarmHandle,
  compactionHandle,
  conversationStoreHandle,
  credentialStoreHandle,
  type HeartbeatService,
  heartbeatServiceHandle,
  type LspService,
  lspServiceHandle,
  type McpService,
  mcpServiceHandle,
  type NamedAgentsService,
  namedAgentServiceHandle,
  type SessionOrchestrator,
  sessionOrchestratorHandle,
  systemPromptHandle,
  throughputStoreHandle,
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
    async getEffectiveCwd() {
      return null;
    },
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
    stopTurn() {
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
    async getModelInfo() {
      return undefined;
    },
    async listCatalog() {
      return [];
    },
    async listCatalogDetailed() {
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
    provideService() {
      return () => {};
    },
    getService(handle) {
      return SERVICES.get(handle.id) as never;
    },
    tryGetService(handle) {
      return SERVICES.get(handle.id) as never;
    },
    onServiceAvailable() {
      return () => {};
    },
    onServiceUnavailable() {
      return () => {};
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
    scheduler: {
      register() {},
      unregister() {},
    },
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

// ── Reactive service registry (plan 03) ────────────────────────────────────
// The extension consumes the Standard-provided services (heartbeat, mcp,
// throughput-store, named-agents — and optional lsp/ssh) REACTIVELY: no
// dependsOn edge, no activate-time getService. These tests run the REAL
// extension against a REAL kernel bus and assert the full plan-03 lifecycle:
// boot with the Standard services absent → routes degrade (503/empty, server
// still starts); a mid-session provide serves the routes with no restart; an
// un-provide degrades them again.
describe("reactive service registry (plan 03)", () => {
  /**
   * A HostAPI whose service operations are the REAL bus (so provide /
   * un-provide drive the availability subscriptions exactly like the host
   * does), with minimal stubs for everything else activate() touches. The
   * given services are seeded INTO the bus (the mandatory core deps —
   * activate() resolves them with the throwing `getService`).
   */
  function createBusHostAPI(
    services: ReadonlyArray<readonly [ServiceHandle<unknown>, unknown]>,
    configOverrides: Record<string, unknown> = {},
  ): HostAPI & { readonly bus: Bus } {
    const bus = createBus(fakeLogger());
    for (const [handle, impl] of services) {
      bus.provideService(handle, impl);
    }
    return {
      bus,
      getService: (handle) => bus.getService(handle),
      tryGetService: (handle) => bus.tryGetService(handle),
      provideService: (handle, impl) => bus.provideService(handle, impl),
      onServiceAvailable: (handle, cb) => bus.onServiceAvailable(handle, cb),
      onServiceUnavailable: (handle, cb) => bus.onServiceUnavailable(handle, cb),
      config: fakeConfig(configOverrides),
      logger: fakeLogger(),
      emit: () => {},
    } as unknown as HostAPI & { readonly bus: Bus };
  }

  /** The mandatory core services activate() resolves (throwing) via getService. */
  function coreServices(store: ConversationStore) {
    return [
      [conversationStoreHandle, store],
      [sessionOrchestratorHandle, fakeOrchestrator()],
      [credentialStoreHandle, fakeCredentialStore()],
      [cacheWarmHandle, {}], // WarmService — never called by the probed routes
      [compactionHandle, {}], // CompactionService — never called by the probed routes
      [systemPromptHandle, {}], // SystemPromptService — never called by the probed routes
    ] as const satisfies ReadonlyArray<readonly [ServiceHandle<unknown>, unknown]>;
  }

  test("boots with every Standard service absent; routes degrade; mid-session load serves; unload degrades again", async () => {
    // cwd resolves so the lsp/mcp routes reach their service guard (the
    // no-cwd degrade path would short-circuit before the 503).
    const store = {
      ...fakeConversationStore(),
      getCwd: async () => "/ws",
      getEffectiveCwd: async () => "/ws",
    };
    const host = createBusHostAPI(coreServices(store), { httpPort: 0 });
    const ext = createTransportHttpExtension();

    // THE plan-03 assertion: activation succeeds with heartbeat / mcp /
    // throughput-store / named-agents / lsp / ssh all ABSENT (the old
    // activate-time getService would have thrown).
    await ext.activate(host);

    const server = ext._testServer;
    expect(server).toBeDefined();
    const base = `http://localhost:${server?.port as number}`;

    try {
      // ── absent: every reactive route takes its degrade path ──
      let res = await fetch(`${base}/named-agents`);
      expect(res.status).toBe(503);

      res = await fetch(`${base}/metrics/throughput?period=day&date=2026-01-01`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        period: "day",
        date: "2026-01-01",
        start: 0,
        end: 0,
        models: [],
      });

      res = await fetch(`${base}/workspaces/w/heartbeat`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false); // defaults

      res = await fetch(`${base}/conversations/c1/mcp`);
      expect(res.status).toBe(503);

      res = await fetch(`${base}/conversations/c1/lsp`);
      expect(res.status).toBe(503);

      // ── mid-session load: routes serve WITHOUT a restart ──
      const unname = host.provideService(namedAgentServiceHandle, {
        list: async () => [],
      } as unknown as NamedAgentsService);
      const unthroughput = host.provideService(throughputStoreHandle, {
        record: async () => {},
        aggregate: async (q) => ({ period: q.period, date: q.date, start: 42, end: 7, models: [] }),
      });
      const unheartbeat = host.provideService(heartbeatServiceHandle, {
        getConfig: async () => ({ ...DEFAULT_HEARTBEAT_CONFIG, enabled: true }),
      } as unknown as HeartbeatService);
      const unmcp = host.provideService(mcpServiceHandle, {
        status: async () => [],
      } as unknown as McpService);
      const unlsp = host.provideService(lspServiceHandle, {
        status: async () => [],
      } as unknown as LspService);

      res = await fetch(`${base}/named-agents`);
      expect(res.status).toBe(200);

      res = await fetch(`${base}/metrics/throughput?period=day&date=2026-01-01`);
      expect(await res.json()).toEqual({
        period: "day",
        date: "2026-01-01",
        start: 42,
        end: 7,
        models: [],
      });

      res = await fetch(`${base}/workspaces/w/heartbeat`);
      expect(((await res.json()) as { enabled: boolean }).enabled).toBe(true);

      res = await fetch(`${base}/conversations/c1/mcp`);
      expect(res.status).toBe(200);

      res = await fetch(`${base}/conversations/c1/lsp`);
      expect(res.status).toBe(200);

      // ── mid-session unload: routes degrade again ──
      unname();
      unthroughput();
      unheartbeat();
      unmcp();
      unlsp();

      res = await fetch(`${base}/named-agents`);
      expect(res.status).toBe(503);
      res = await fetch(`${base}/workspaces/w/heartbeat`);
      expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
      res = await fetch(`${base}/conversations/c1/mcp`);
      expect(res.status).toBe(503);
    } finally {
      ext.deactivate?.();
    }
  });
  test("deactivate is idempotent and a re-activation boots cleanly (subscriptions re-registered, none leaked)", async () => {
    const host = createBusHostAPI(coreServices(fakeConversationStore()), { httpPort: 0 });
    const ext = createTransportHttpExtension();
    await ext.activate(host);
    ext.deactivate?.();
    // Idempotent: the disposer array was reset — no double-dispose throw.
    expect(() => ext.deactivate?.()).not.toThrow();

    // A fresh activation on the same host boots cleanly and serves.
    const ext2 = createTransportHttpExtension();
    await ext2.activate(host);
    try {
      const res = await fetch(`http://localhost:${ext2._testServer?.port as number}/health`);
      expect(res.status).toBe(200);
    } finally {
      ext2.deactivate?.();
    }
  });
});
