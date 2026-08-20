import type { AgentEvent } from "@dispatch/kernel";
import {
  isDuplicateName,
  isValidCanonicalModel,
  isValidName,
  type NamedAgent,
  type NamedAgentsService,
  normalizeName,
} from "@dispatch/named-agents";
import type { NamedAgentSelectionSnapshot } from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ConversationStore } from "./seam.js";

/**
 * A minimal `ConversationStore` fake covering only the model + Named Agent
 * selection surface exercised by these routes. It models the CR'd store
 * behavior that `setModel(id, "")` (the clear path) also clears the Named
 * Agent selection snapshot. Tests for routes touching other store methods live
 * in `app.test.ts`; this fake intentionally carries only what these routes
 * call (isolation-over-DRY — a small self-contained fake per test file).
 */
function createNamedAgentAwareStore(
  modelStore: Map<string, string> = new Map(),
  snapshotStore: Map<string, NamedAgentSelectionSnapshot> = new Map(),
): ConversationStore {
  return {
    async getModel(id) {
      return modelStore.get(id) ?? null;
    },
    async setModel(id, model) {
      if (model === "") {
        modelStore.delete(id);
        // Mirrors the CR'd store behavior: clearing the model also clears the
        // Named Agent selection snapshot.
        snapshotStore.delete(id);
      } else {
        modelStore.set(id, model);
      }
    },
    async getNamedAgentSelection(id) {
      return snapshotStore.get(id) ?? null;
    },
    async setNamedAgentSelection(id, snapshot) {
      snapshotStore.set(id, snapshot);
    },
  } as unknown as ConversationStore;
}

/**
 * A `NamedAgentsService` fake backed by an in-memory record set that uses the
 * REAL pure validators from `@dispatch/named-agents` (so create/update return
 * the same typed errors the real registry does). `generateId` is deterministic
 * so tests can assert on ids.
 */
function createFakeNamedAgentsService(
  initial: NamedAgent[] = [],
  generateId: () => string = () =>
    `id-${initial.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
): NamedAgentsService {
  const records: NamedAgent[] = [...initial];
  return {
    async list() {
      return [...records].sort((a, b) =>
        normalizeName(a.name).toLowerCase().localeCompare(normalizeName(b.name).toLowerCase()),
      );
    },
    async get(id) {
      return records.find((r) => r.id === id) ?? null;
    },
    async getByName(name) {
      const target = normalizeName(name).toLowerCase();
      return records.find((r) => normalizeName(r.name).toLowerCase() === target) ?? null;
    },
    async create(input) {
      if (!isValidName(input.name)) return { ok: false, error: "invalid-name" };
      if (!isValidCanonicalModel(input.model)) return { ok: false, error: "invalid-model" };
      if (isDuplicateName(records, input.name)) return { ok: false, error: "duplicate-name" };
      const agent: NamedAgent = {
        id: generateId(),
        name: normalizeName(input.name),
        model: input.model,
      };
      records.push(agent);
      return { ok: true, agent };
    },
    async update(id, input) {
      const current = records.find((r) => r.id === id);
      if (current === undefined) return { ok: false, error: "not-found" };
      if (!isValidName(input.name)) return { ok: false, error: "invalid-name" };
      if (!isValidCanonicalModel(input.model)) return { ok: false, error: "invalid-model" };
      const others = records.filter((r) => r.id !== id);
      if (isDuplicateName(others, input.name)) return { ok: false, error: "duplicate-name" };
      const updated: NamedAgent = { id, name: normalizeName(input.name), model: input.model };
      const idx = records.findIndex((r) => r.id === id);
      records[idx as number] = updated;
      return { ok: true, agent: updated };
    },
    async delete(id) {
      const idx = records.findIndex((r) => r.id === id);
      if (idx === -1) return { ok: false, error: "not-found", id };
      records.splice(idx, 1);
      return { ok: true, id };
    },
    async resolve(ref) {
      const byId = records.find((r) => r.id === ref);
      if (byId !== undefined) return byId;
      const target = normalizeName(ref).toLowerCase();
      return records.find((r) => normalizeName(r.name).toLowerCase() === target) ?? null;
    },
  };
}

/** A `NamedAgentsService` whose list throws — for the storage-failure → 500 path. */
function createThrowingNamedAgentsService(): NamedAgentsService {
  return {
    ...createFakeNamedAgentsService(),
    async list() {
      throw new Error("storage down");
    },
  };
}

function fakeOrchestrator(): { handleMessage: () => Promise<void> } {
  return {
    async handleMessage() {},
  };
}

const snapshot = (
  overrides: Partial<NamedAgentSelectionSnapshot> = {},
): NamedAgentSelectionSnapshot => ({
  namedAgentId: "na-1",
  namedAgentName: "Coding Agent",
  model: "umans/umans-glm-5.2",
  ...overrides,
});

// ─── /named-agents CRUD ──────────────────────────────────────────────────────

describe("GET /named-agents", () => {
  it("returns the registry list", async () => {
    const svc = createFakeNamedAgentsService([
      { id: "a", name: "Coding", model: "umans/umans-glm-5.2" },
      { id: "b", name: "Research", model: "openai/gpt-4" },
    ]);
    const app = createApp({
      conversationStore: createNamedAgentAwareStore(),
      orchestrator: fakeOrchestrator() as never,
      credentialStore: {
        resolve: () => undefined,
        async getModelInfo() {
          return undefined;
        },
        async listCatalog() {
          return [];
        },
        async listCatalogDetailed() {
          return [];
        },
      },
      namedAgentService: svc,
    });
    const res = await app.request("/named-agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { namedAgents: NamedAgent[] };
    expect(body.namedAgents).toHaveLength(2);
    // Deterministic case-insensitive name order.
    expect(body.namedAgents.map((n) => n.name)).toEqual(["Coding", "Research"]);
  });

  it("returns 503 when the service is absent", async () => {
    const app = createApp({
      conversationStore: createNamedAgentAwareStore(),
      orchestrator: fakeOrchestrator() as never,
      credentialStore: {
        resolve: () => undefined,
        async getModelInfo() {
          return undefined;
        },
        async listCatalog() {
          return [];
        },
        async listCatalogDetailed() {
          return [];
        },
      },
    });
    const res = await app.request("/named-agents");
    expect(res.status).toBe(503);
  });

  it("returns 500 when the service list throws", async () => {
    const app = createApp({
      conversationStore: createNamedAgentAwareStore(),
      orchestrator: fakeOrchestrator() as never,
      credentialStore: {
        resolve: () => undefined,
        async getModelInfo() {
          return undefined;
        },
        async listCatalog() {
          return [];
        },
        async listCatalogDetailed() {
          return [];
        },
      },
      namedAgentService: createThrowingNamedAgentsService(),
    });
    const res = await app.request("/named-agents");
    expect(res.status).toBe(500);
  });
});

describe("POST /named-agents", () => {
  function appWith(svc: NamedAgentsService) {
    return createApp({
      conversationStore: createNamedAgentAwareStore(),
      orchestrator: fakeOrchestrator() as never,
      credentialStore: {
        resolve: () => undefined,
        async getModelInfo() {
          return undefined;
        },
        async listCatalog() {
          return [];
        },
        async listCatalogDetailed() {
          return [];
        },
      },
      namedAgentService: svc,
    });
  }

  it("creates a Named Agent and returns the canonical record", async () => {
    const svc = createFakeNamedAgentsService([], () => "stable-id");
    const res = await appWith(svc).request("/named-agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Coding Agent", model: "umans/umans-glm-5.2" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { namedAgent: NamedAgent };
    expect(body.namedAgent.id).toBe("stable-id");
    expect(body.namedAgent.name).toBe("Coding Agent");
    expect(body.namedAgent.model).toBe("umans/umans-glm-5.2");
    // Persisted: a subsequent list includes it.
    const list = await appWith(svc).request("/named-agents");
    const listBody = (await list.json()) as { namedAgents: NamedAgent[] };
    expect(listBody.namedAgents).toHaveLength(1);
  });

  it("returns 409 for a duplicate name", async () => {
    const svc = createFakeNamedAgentsService([
      { id: "x", name: "Coding", model: "umans/umans-glm-5.2" },
    ]);
    const res = await appWith(svc).request("/named-agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "coding", model: "openai/gpt-4" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("already exists");
  });

  it("returns 400 for an invalid (empty) name", async () => {
    const res = await appWith(createFakeNamedAgentsService()).request("/named-agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   ", model: "umans/umans-glm-5.2" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid (non-canonical) model", async () => {
    const res = await appWith(createFakeNamedAgentsService()).request("/named-agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Coding", model: "no-slash-here" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name is not a string", async () => {
    const res = await appWith(createFakeNamedAgentsService()).request("/named-agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 42, model: "umans/umans-glm-5.2" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await appWith(createFakeNamedAgentsService()).request("/named-agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /named-agents/:id", () => {
  function appWith(svc: NamedAgentsService) {
    return createApp({
      conversationStore: createNamedAgentAwareStore(),
      orchestrator: fakeOrchestrator() as never,
      credentialStore: {
        resolve: () => undefined,
        async getModelInfo() {
          return undefined;
        },
        async listCatalog() {
          return [];
        },
        async listCatalogDetailed() {
          return [];
        },
      },
      namedAgentService: svc,
    });
  }

  it("updates a Named Agent and returns the canonical record", async () => {
    const svc = createFakeNamedAgentsService([
      { id: "x", name: "Coding", model: "umans/umans-glm-5.2" },
    ]);
    const res = await appWith(svc).request("/named-agents/x", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Coding Pro", model: "openai/gpt-4" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { namedAgent: NamedAgent };
    expect(body.namedAgent.id).toBe("x");
    expect(body.namedAgent.name).toBe("Coding Pro");
    expect(body.namedAgent.model).toBe("openai/gpt-4");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await appWith(createFakeNamedAgentsService()).request("/named-agents/missing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Coding", model: "umans/umans-glm-5.2" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when renaming to a duplicate name", async () => {
    const svc = createFakeNamedAgentsService([
      { id: "a", name: "Coding", model: "umans/umans-glm-5.2" },
      { id: "b", name: "Research", model: "openai/gpt-4" },
    ]);
    const res = await appWith(svc).request("/named-agents/a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "research", model: "umans/umans-glm-5.2" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 400 for an invalid model", async () => {
    const svc = createFakeNamedAgentsService([
      { id: "a", name: "Coding", model: "umans/umans-glm-5.2" },
    ]);
    const res = await appWith(svc).request("/named-agents/a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Coding", model: "bad-model" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /named-agents/:id", () => {
  function appWith(svc: NamedAgentsService) {
    return createApp({
      conversationStore: createNamedAgentAwareStore(),
      orchestrator: fakeOrchestrator() as never,
      credentialStore: {
        resolve: () => undefined,
        async getModelInfo() {
          return undefined;
        },
        async listCatalog() {
          return [];
        },
        async listCatalogDetailed() {
          return [];
        },
      },
      namedAgentService: svc,
    });
  }

  it("deletes a Named Agent and confirms the id", async () => {
    const svc = createFakeNamedAgentsService([
      { id: "x", name: "Coding", model: "umans/umans-glm-5.2" },
    ]);
    const res = await appWith(svc).request("/named-agents/x", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("x");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await appWith(createFakeNamedAgentsService()).request("/named-agents/missing", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 503 when the service is absent", async () => {
    const app = createApp({
      conversationStore: createNamedAgentAwareStore(),
      orchestrator: fakeOrchestrator() as never,
      credentialStore: {
        resolve: () => undefined,
        async getModelInfo() {
          return undefined;
        },
        async listCatalog() {
          return [];
        },
        async listCatalogDetailed() {
          return [];
        },
      },
    });
    const res = await app.request("/named-agents/x", { method: "DELETE" });
    expect(res.status).toBe(503);
  });
});

// ─── per-conversation snapshot surfacing ─────────────────────────────────────

function baseCred() {
  return {
    resolve: () => undefined,
    async getModelInfo() {
      return undefined;
    },
    async listCatalog() {
      return [] as string[];
    },
    async listCatalogDetailed() {
      return [] as { name: string; info: { id: string } }[];
    },
  };
}

describe("GET /conversations/:id/model — namedAgent snapshot", () => {
  it("includes namedAgent when a snapshot is stored", async () => {
    const snap = snapshot();
    const store = createNamedAgentAwareStore(
      new Map([["conv1", "umans/umans-glm-5.2"]]),
      new Map([["conv1", snap]]),
    );
    const app = createApp({
      conversationStore: store,
      orchestrator: fakeOrchestrator() as never,
      credentialStore: baseCred(),
    });
    const res = await app.request("/conversations/conv1/model");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversationId: string;
      model: string | null;
      namedAgent?: NamedAgentSelectionSnapshot;
    };
    expect(body.model).toBe("umans/umans-glm-5.2");
    expect(body.namedAgent).toEqual(snap);
  });

  it("omits namedAgent when no snapshot is stored", async () => {
    const store = createNamedAgentAwareStore(new Map([["conv1", "umans/umans-glm-5.2"]]));
    const app = createApp({
      conversationStore: store,
      orchestrator: fakeOrchestrator() as never,
      credentialStore: baseCred(),
    });
    const res = await app.request("/conversations/conv1/model");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversationId: string;
      model: string | null;
      namedAgent?: NamedAgentSelectionSnapshot;
    };
    expect(body.model).toBe("umans/umans-glm-5.2");
    expect(body.namedAgent).toBeUndefined();
  });
});

describe("PUT /conversations/:id/model — namedAgent snapshot", () => {
  it("persists a namedAgent alongside the model and returns it", async () => {
    const modelStore = new Map<string, string>();
    const snapshotStore = new Map<string, NamedAgentSelectionSnapshot>();
    const store = createNamedAgentAwareStore(modelStore, snapshotStore);
    const app = createApp({
      conversationStore: store,
      orchestrator: fakeOrchestrator() as never,
      credentialStore: baseCred(),
    });
    const snap = snapshot({ namedAgentId: "na-9", namedAgentName: "Research" });
    const res = await app.request("/conversations/conv1/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "umans/umans-glm-5.2", namedAgent: snap }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversationId: string;
      model: string | null;
      namedAgent?: NamedAgentSelectionSnapshot;
    };
    expect(body.model).toBe("umans/umans-glm-5.2");
    expect(body.namedAgent).toEqual(snap);
    // Persisted: a subsequent GET reflects the snapshot.
    const getRes = await app.request("/conversations/conv1/model");
    const getBody = (await getRes.json()) as { namedAgent?: NamedAgentSelectionSnapshot };
    expect(getBody.namedAgent).toEqual(snap);
  });

  it("leaves an existing snapshot unchanged on a raw-model set (no namedAgent)", async () => {
    const snap = snapshot();
    const modelStore = new Map<string, string>([["conv1", "umans/umans-glm-5.2"]]);
    const snapshotStore = new Map<string, NamedAgentSelectionSnapshot>([["conv1", snap]]);
    const store = createNamedAgentAwareStore(modelStore, snapshotStore);
    const app = createApp({
      conversationStore: store,
      orchestrator: fakeOrchestrator() as never,
      credentialStore: baseCred(),
    });
    const res = await app.request("/conversations/conv1/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-4" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string | null;
      namedAgent?: NamedAgentSelectionSnapshot;
    };
    expect(body.model).toBe("openai/gpt-4");
    // The existing snapshot is preserved (raw-model set does not clear it).
    expect(body.namedAgent).toEqual(snap);
  });

  it("clears both model and snapshot when model is null", async () => {
    const snap = snapshot();
    const modelStore = new Map<string, string>([["conv1", "umans/umans-glm-5.2"]]);
    const snapshotStore = new Map<string, NamedAgentSelectionSnapshot>([["conv1", snap]]);
    const store = createNamedAgentAwareStore(modelStore, snapshotStore);
    const app = createApp({
      conversationStore: store,
      orchestrator: fakeOrchestrator() as never,
      credentialStore: baseCred(),
    });
    const res = await app.request("/conversations/conv1/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string | null;
      namedAgent?: NamedAgentSelectionSnapshot;
    };
    expect(body.model).toBeNull();
    expect(body.namedAgent).toBeUndefined();
    // Persisted: a subsequent GET shows no model and no snapshot.
    const getRes = await app.request("/conversations/conv1/model");
    const getBody = (await getRes.json()) as {
      model: string | null;
      namedAgent?: NamedAgentSelectionSnapshot;
    };
    expect(getBody.model).toBeNull();
    expect(getBody.namedAgent).toBeUndefined();
  });

  it("returns 400 for a malformed namedAgent snapshot", async () => {
    const app = createApp({
      conversationStore: createNamedAgentAwareStore(),
      orchestrator: fakeOrchestrator() as never,
      credentialStore: baseCred(),
    });
    const res = await app.request("/conversations/conv1/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "umans/umans-glm-5.2", namedAgent: { namedAgentId: "x" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /chat — namedAgent snapshot", () => {
  it("persists a namedAgent snapshot on the conversation (fail-open)", async () => {
    const modelStore = new Map<string, string>();
    const snapshotStore = new Map<string, NamedAgentSelectionSnapshot>();
    const store = createNamedAgentAwareStore(modelStore, snapshotStore);
    const orch = {
      async handleMessage() {},
    };
    const app = createApp({
      conversationStore: store,
      orchestrator: orch as never,
      credentialStore: baseCred(),
    });
    const snap = snapshot({ namedAgentId: "na-7", namedAgentName: "Fast" });
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", conversationId: "conv1", namedAgent: snap }),
    });
    expect(res.status).toBe(200);
    // The snapshot was persisted on the conversation.
    expect(snapshotStore.get("conv1")).toEqual(snap);
  });

  it("does not fail the turn when the snapshot write throws (fail-open)", async () => {
    const throwingStore = {
      async getModel() {
        return null;
      },
      async setModel() {},
      async getNamedAgentSelection() {
        return null;
      },
      async setNamedAgentSelection() {
        throw new Error("snapshot write failed");
      },
    } as unknown as ConversationStore;
    const orch = {
      async handleMessage() {},
    };
    const app = createApp({
      conversationStore: throwingStore,
      orchestrator: orch as never,
      credentialStore: baseCred(),
    });
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hi",
        conversationId: "conv1",
        namedAgent: snapshot(),
      }),
    });
    // Fail-open: the chat turn still succeeds (200) despite the snapshot error.
    expect(res.status).toBe(200);
  });

  it("returns 400 for a malformed namedAgent snapshot", async () => {
    const app = createApp({
      conversationStore: createNamedAgentAwareStore(),
      orchestrator: fakeOrchestrator() as never,
      credentialStore: baseCred(),
    });
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hi",
        conversationId: "conv1",
        namedAgent: { namedAgentId: 42 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("forwards a valid event stream with a namedAgent present", async () => {
    const events: AgentEvent[] = [
      { type: "turn-start", conversationId: "conv1", turnId: "t1" },
      { type: "done", conversationId: "conv1", turnId: "t1", reason: "stop" },
    ];
    const orch = {
      async handleMessage(input: { onEvent: (e: AgentEvent) => void }) {
        for (const e of events) input.onEvent(e);
      },
    };
    const snapshotStore = new Map<string, NamedAgentSelectionSnapshot>();
    const app = createApp({
      conversationStore: createNamedAgentAwareStore(new Map(), snapshotStore),
      orchestrator: orch as never,
      credentialStore: baseCred(),
    });
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hi",
        conversationId: "conv1",
        namedAgent: snapshot(),
      }),
    });
    expect(res.status).toBe(200);
    expect(snapshotStore.get("conv1")).toBeDefined();
    const text = await res.text();
    expect(text.trim().split("\n").length).toBe(2);
  });
});
