import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HEARTBEAT_CONFIG } from "@dispatch/heartbeat";
import {
  type Bus,
  type ConfigAccess,
  createBus,
  type HostAPI,
  type Logger,
  type ServiceHandle,
  type StorageNamespace,
} from "@dispatch/kernel";
import { DEFAULT_LAYOUT, type LayoutTree } from "@dispatch/layout-contract";
import {
  createLayoutProvider,
  createLayoutProviderRegistry,
  layoutProviderRegistryHandle,
} from "@dispatch/layout-provider-contract";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
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

/** An in-memory StorageNamespace (the kernel-test shape) for the kit. */
function memoryNamespace(): StorageNamespace {
  const store = new Map<string, string>();
  return {
    ...storageFromMap(store),
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    has: async (key) => store.has(key),
    keys: async () => [...store.keys()],
  };
}

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
    async runExclusive(_conversationId, fn) {
      return await fn();
    },
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
    async getTabGroupParentId() {
      return null;
    },
    async setTabGroupParentId() {},
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
        ...storageFromMap(new Map<string, string>()),
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

  test("layout routes (plan 02): 404 with no provider, serve a mid-session load, 404 again after un-provide", async () => {
    const host = createBusHostAPI(coreServices(fakeConversationStore()), { httpPort: 0 });
    const ext = createTransportHttpExtension();
    await ext.activate(host);
    const server = ext._testServer;
    expect(server).toBeDefined();
    const base = `http://localhost:${server?.port as number}`;

    try {
      // ── absent: every layout route 404s (the frontend's no-provider signal) ──
      let res = await fetch(`${base}/workspaces/w/layout`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No layout plugin is enabled in this workspace" });

      res = await fetch(`${base}/workspaces/w/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tree: DEFAULT_LAYOUT }),
      });
      expect(res.status).toBe(404);

      res = await fetch(`${base}/workspaces/w/layout`, { method: "DELETE" });
      expect(res.status).toBe(404);

      // ── mid-session load: a registry + a registered kit provider serve with
      // NO restart (the picker serves the workspace's enabled plugin — here a
      // stub enabling the single registered one, as the layout-provider-
      // registry extension computes from the per-workspace enablement state) ──
      const emitted: unknown[] = [];
      const provider = createLayoutProvider({
        storage: memoryNamespace(),
        defaultTree: DEFAULT_LAYOUT,
        emitChange: (message) => {
          emitted.push(message);
        },
        logger: fakeLogger(),
      });
      const registry = createLayoutProviderRegistry({
        pickPlugin: async () => "layout-under-test",
        logger: fakeLogger(),
      });
      registry.register("layout-under-test", provider);
      const unprovide = host.provideService(layoutProviderRegistryHandle, registry);

      res = await fetch(`${base}/workspaces/w/layout`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tree: DEFAULT_LAYOUT });

      // PUT a valid tree → 200 { tree }.
      const swapped: LayoutTree = { version: 1, root: { kind: "leaf", view: "tabs" } };
      res = await fetch(`${base}/workspaces/w/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tree: swapped }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tree: swapped });

      // PUT a structurally invalid tree → 400 { error }.
      res = await fetch(`${base}/workspaces/w/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tree: { version: 1, root: { kind: "split", dir: "row", children: [] } },
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({ error: expect.any(String) });

      // DELETE → 200 { tree: freshSeed }, and a following GET re-seeds.
      res = await fetch(`${base}/workspaces/w/layout`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tree: DEFAULT_LAYOUT });
      res = await fetch(`${base}/workspaces/w/layout`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tree: DEFAULT_LAYOUT });

      // ── un-provide: routes 404 again (the degrade path) ──
      unprovide();
      res = await fetch(`${base}/workspaces/w/layout`);
      expect(res.status).toBe(404);
    } finally {
      ext.deactivate?.();
    }
  });

  test("POST /workspaces/:id/layout/ops (plan 04): 404 no provider, 400 bad op, 200 { tree, applied }", async () => {
    const host = createBusHostAPI(coreServices(fakeConversationStore()), { httpPort: 0 });
    const ext = createTransportHttpExtension();
    await ext.activate(host);
    const server = ext._testServer;
    expect(server).toBeDefined();
    const base = `http://localhost:${server?.port as number}`;

    try {
      // ── absent: the ops route 404s like its sibling layout routes ──
      let res = await fetch(`${base}/workspaces/w/layout/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: [] }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No layout plugin is enabled in this workspace" });

      // ── a live registry with a registered kit provider ──
      const registry2 = createLayoutProviderRegistry({
        pickPlugin: async () => "layout-under-test",
        logger: fakeLogger(),
      });
      registry2.register(
        "layout-under-test",
        createLayoutProvider({
          storage: memoryNamespace(),
          defaultTree: DEFAULT_LAYOUT,
          emitChange: () => {},
          logger: fakeLogger(),
        }),
      );
      const unprovide = host.provideService(layoutProviderRegistryHandle, registry2);

      // Malformed body (unknown op type) → 400 { error }.
      res = await fetch(`${base}/workspaces/w/layout/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: [{ type: "teleport" }] }),
      });
      expect(res.status).toBe(400);
      const badBody = (await res.json()) as { error: string; failedOp?: number };
      expect(badBody.error).toContain("ops[0]");

      // A known-typed op with junk fields → 400 { error, failedOp }.
      res = await fetch(`${base}/workspaces/w/layout/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: [{ type: "ensurePanel", view: "tasks" }] }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: expect.stringContaining("op 0"),
        failedOp: 0,
      });

      // A valid batch → 200 { tree, applied }; a follow-up GET sees the result.
      res = await fetch(`${base}/workspaces/w/layout/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ops: [{ type: "ensurePanel", panels: "side", view: "tasks" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tree: expect.anything(), applied: 1 });

      res = await fetch(`${base}/workspaces/w/layout`);
      expect(res.status).toBe(200);
      const { tree } = (await res.json()) as { tree: LayoutTree };
      expect(JSON.stringify(tree)).toContain('"tasks"');

      // ── un-provide: the ops route 404s again ──
      unprovide();
      res = await fetch(`${base}/workspaces/w/layout/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: [] }),
      });
      expect(res.status).toBe(404);
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

describe("real multi-listener lifecycle", () => {
  test("binds both loopbacks on ephemeral ports and releases both", async () => {
    const { startListeners } = await import("./extension.js");
    const listeners = startListeners(
      ["127.0.0.1", "::1"],
      [],
      (hostname) => Bun.serve({ hostname, port: 0, fetch: () => Response.json({ ok: true }) }),
      fakeLogger(),
    );
    const urls = listeners.servers.map((server) => server.url.toString());
    try {
      for (const url of urls) expect((await fetch(url)).status).toBe(200);
    } finally {
      listeners.stop();
    }
    for (const url of urls) await expect(fetch(url)).rejects.toThrow();
  });
});

// Bun.file responses must be exercised in Bun, not the Node-based Vitest suite.
describe("GET /local-image streaming", () => {
  const pngBytes = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const gifBytes = new TextEncoder().encode("GIF89a");
  const bmpBytes = new TextEncoder().encode("BM6\0\0\0");

  const formats: readonly {
    readonly ext: string;
    readonly mime: string;
    readonly bytes: Uint8Array;
  }[] = [
    { ext: ".png", mime: "image/png", bytes: pngBytes },
    { ext: ".jpg", mime: "image/jpeg", bytes: jpegBytes },
    { ext: ".jpeg", mime: "image/jpeg", bytes: jpegBytes },
    { ext: ".webp", mime: "image/webp", bytes: webpBytes },
    { ext: ".gif", mime: "image/gif", bytes: gifBytes },
    { ext: ".bmp", mime: "image/bmp", bytes: bmpBytes },
  ];

  function createTestApp() {
    return createApp({
      conversationStore: fakeConversationStore(),
      orchestrator: fakeOrchestrator(),
      credentialStore: fakeCredentialStore(),
    });
  }

  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-local-image-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("serves a real image file of each whitelisted format with its MIME type", async () => {
    await withTempDir(async (dir) => {
      const app = createTestApp();
      for (const format of formats) {
        const file = join(dir, `pic${format.ext}`);
        await writeFile(file, format.bytes);
        const res = await app.request(`/local-image?path=${encodeURIComponent(file)}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(format.mime);
        expect(res.headers.get("cache-control")).toBe("no-cache");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(format.bytes);
      }
    });
  });

  test("streams a PNG at the inclusive 25 MiB limit", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "limit.png");
      await writeFile(file, pngBytes);
      await truncate(file, 25 * 1024 * 1024);
      const res = await createTestApp().request(`/local-image?path=${encodeURIComponent(file)}`);
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      if (reader === undefined) throw new Error("Expected a streamed response body");
      let total = 0;
      let chunks = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total === 0) expect(value.subarray(0, pngBytes.length)).toEqual(pngBytes);
        total += value.length;
        chunks++;
      }
      expect(total).toBe(25 * 1024 * 1024);
      expect(chunks).toBeGreaterThan(1);
    });
  });

  test.skipIf(Bun.which("mkfifo") === null)(
    "rejects a FIFO named x.png without a writer",
    async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, "x.png");
        const result = spawnSync("mkfifo", [file]);
        expect(result.status).toBe(0);
        const res = await createTestApp().request(`/local-image?path=${encodeURIComponent(file)}`);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Image must be a regular file" });
      });
    },
    2000,
  );
});
