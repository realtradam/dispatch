/**
 * Service-level tests for the agent-management imperative shell (plan §14
 * backend). These exercise `listModels` + `summon` against the REAL
 * `@dispatch/named-agents` registry and the REAL `@dispatch/conversation-store`
 * (both backed by an in-memory StorageNamespace — the outermost edge), plus
 * focused fakes for the credential-store (the catalog edge) and the
 * session-orchestrator. No `@dispatch/*` module is mocked; only the outermost
 * edges are doubled, matching the constitution's imperative-shell testing rule.
 */

import { conversationStoreHandle, createConversationStore } from "@dispatch/conversation-store";
import type { CredentialStore } from "@dispatch/credential-store";
import { createLogger, type StorageNamespace } from "@dispatch/kernel";
import { createNamedAgentsService, type NamedAgentsService } from "@dispatch/named-agents";
import {
  conversationOpened,
  type SessionOrchestrator,
  type StartTurnInput,
} from "@dispatch/session-orchestrator";
import type { NamedAgent, NamedAgentSelectionSnapshot } from "@dispatch/wire";
import { describe, expect, it, vi } from "vitest";
import { type AgentManagementDeps, createAgentManagementService } from "./service.js";

// ─── in-memory StorageNamespace (the outermost edge) ────────────────────────

function makeStorage(): StorageNamespace & {
  readonly dump: () => ReadonlyMap<string, string>;
} {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async has(key) {
      return map.has(key);
    },
    async keys(prefix) {
      const all = [...map.keys()];
      const filtered = prefix === undefined ? all : all.filter((k) => k.startsWith(prefix));
      return filtered.sort();
    },
    dump() {
      return new Map(map);
    },
  };
}

// ─── focused credential-store fake (the catalog edge) ───────────────────────
//
// Only the raw-model summon path touches the catalog; the Named Agent paths
// must perform ZERO catalog calls. `listCatalog` is a spy so tests assert it
// was never invoked on the Named Agent paths.

function makeFakeCredentialStore(catalog: readonly string[]): CredentialStore {
  return {
    listCatalog: vi.fn(async () => catalog),
    listCatalogDetailed: vi.fn(async () =>
      catalog.map((name) => ({ name, info: { id: name.split("/")[1] ?? name } })),
    ),
    getModelInfo: vi.fn(async (name: string) =>
      catalog.includes(name) ? { id: name.split("/")[1] ?? name } : undefined,
    ),
    resolve: vi.fn((name: string) => {
      const [cred, ...rest] = name.split("/");
      if (rest.length === 0) return undefined;
      return catalog.includes(name) ? { providerId: cred, model: rest.join("/") } : undefined;
    }),
  } as CredentialStore;
}

// ─── focused session-orchestrator fake ──────────────────────────────────────

function makeFakeOrchestrator(): SessionOrchestrator & {
  readonly startTurnCalls: readonly StartTurnInput[];
} {
  const startTurnCalls: StartTurnInput[] = [];
  const fake = {
    startTurn(input: StartTurnInput) {
      startTurnCalls.push(input);
      return { started: true as const, turnId: "turn-1" };
    },
    enqueue: vi.fn(() => ({ startedTurn: true, queue: [] })),
    cancelQueuedMessage: vi.fn(() => ({ cancelled: false, queue: [] })),
    subscribe: vi.fn(() => () => {}),
    isActive: vi.fn(() => false),
    getActiveConversationCount: vi.fn(() => 0),
    closeConversation: vi.fn(() => ({ abortedTurn: false })),
    stopTurn: vi.fn(() => ({ abortedTurn: false })),
    handleMessage: vi.fn(async () => {}),
  };
  return Object.assign(fake as SessionOrchestrator, { startTurnCalls });
}

// ─── deps factory ───────────────────────────────────────────────────────────

const BOUNDS = {
  maxWaitMs: 1000,
  defaultListLimit: 50,
  maxListLimit: 200,
  defaultModelLimit: 50,
  maxModelLimit: 200,
  maxFileBytes: 1_048_576,
  defaultReadChars: 8000,
  maxReadChars: 32000,
};

function makeDeps(opts: {
  readonly namedAgents: NamedAgentsService;
  readonly credentialStore: CredentialStore;
  readonly orchestrator?: SessionOrchestrator;
}): { readonly deps: AgentManagementDeps; readonly store: ReturnType<typeof makeStorage> } {
  const store = makeStorage();
  const logger = createLogger(
    { extensionId: "agent-management-test" },
    { emit: () => {} },
    { now: () => 0, newId: () => "id" },
  );
  const orchestrator = opts.orchestrator ?? makeFakeOrchestrator();
  let idCounter = 0;
  const deps: AgentManagementDeps = {
    conversationStore: createConversationStore(store, logger),
    credentialStore: opts.credentialStore,
    namedAgents: opts.namedAgents,
    resolveOrchestrator: () => orchestrator,
    emit: () => {},
    readFileContent: async () => "",
    generateId: () => `conv-${++idCounter}`,
    logger,
    ...BOUNDS,
  };
  return { deps, store };
}

/** Create a real named-agents registry over an in-memory namespace. */
async function makeNamedAgents(records?: readonly NamedAgent[]): Promise<{
  readonly service: NamedAgentsService;
  readonly storage: ReturnType<typeof makeStorage>;
}> {
  const storage = makeStorage();
  const service = createNamedAgentsService(storage, {
    generateId: () => `na-${Math.random().toString(36).slice(2, 10)}`,
  });
  for (const r of records ?? []) {
    await service.create({ name: r.name, model: r.model });
  }
  return { service, storage };
}

// ─── list_agent_models: local Named Agents only ─────────────────────────────

describe("AgentManagementService.listModels — local Named Agents only", () => {
  it("returns only persisted Named Agents (name + resolved model)", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
      { id: "y", name: "Research Agent", model: "umans/umans-glm-5.2" },
    ]);
    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5", "umans/umans-glm-5.2"]);
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred });
    const svc = createAgentManagementService(deps);

    const res = await svc.listModels({ callerConversationId: "caller-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.models).toHaveLength(2);
    const names = res.value.models.map((m) => m.name).sort();
    expect(names).toEqual(["Coding Agent", "Research Agent"]);
    const coding = res.value.models.find((m) => m.name === "Coding Agent");
    expect(coding?.model).toBe("opencode-1/claude-sonnet-4.5");
    expect(coding?.namedAgentId).toBeDefined();
  });

  it("performs ZERO provider-catalog calls", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
    ]);
    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5"]);
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred });
    const svc = createAgentManagementService(deps);

    await svc.listModels({ callerConversationId: "caller-1" });
    expect(cred.listCatalog).not.toHaveBeenCalled();
    expect(cred.getModelInfo).not.toHaveBeenCalled();
    expect(cred.listCatalogDetailed).not.toHaveBeenCalled();
  });

  it("empty registry → empty list (no raw-catalog fallback)", async () => {
    const { service } = await makeNamedAgents();
    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5"]);
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred });
    const svc = createAgentManagementService(deps);

    const res = await svc.listModels({ callerConversationId: "caller-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.models).toHaveLength(0);
    // And still no catalog call.
    expect(cred.listCatalog).not.toHaveBeenCalled();
  });

  it("query filters over the Named Agent name (case-insensitive)", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/a" },
      { id: "y", name: "Research Agent", model: "umans/b" },
    ]);
    const cred = makeFakeCredentialStore([]);
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred });
    const svc = createAgentManagementService(deps);

    const res = await svc.listModels({ callerConversationId: "caller-1", query: "cod" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.models.map((m) => m.name)).toEqual(["Coding Agent"]);
  });

  it("requires a caller conversation id", async () => {
    const { service } = await makeNamedAgents();
    const cred = makeFakeCredentialStore([]);
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred });
    const svc = createAgentManagementService(deps);

    const res = await svc.listModels({ callerConversationId: "" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid-input");
  });
});

// ─── summon_agent: Named Agent selector ─────────────────────────────────────

describe("AgentManagementService.summon — Named Agent selector", () => {
  it("resolves the saved raw model and writes the selection snapshot", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
    ]);
    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5"]);
    const orchestrator = makeFakeOrchestrator();
    const { deps, store } = makeDeps({
      namedAgents: service,
      credentialStore: cred,
      orchestrator,
    });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      agent: "Coding Agent",
      task: "do the thing",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const childId = res.value.conversationId;

    // The resolved raw model was used for startTurn.
    const started = orchestrator.startTurnCalls[0];
    expect(started?.modelName).toBe("opencode-1/claude-sonnet-4.5");

    // The snapshot was frozen onto the conversation.
    const snap = await deps.conversationStore.getNamedAgentSelection(childId);
    const expected: NamedAgentSelectionSnapshot = {
      namedAgentId: snap?.namedAgentId ?? "",
      namedAgentName: "Coding Agent",
      model: "opencode-1/claude-sonnet-4.5",
    };
    expect(snap).not.toBeNull();
    expect(snap).toMatchObject({
      namedAgentName: expected.namedAgentName,
      model: expected.model,
    });
    expect(snap?.namedAgentId).toBeDefined();
    // The conversation-store handle re-export is unused at runtime here; this
    // assertion guards against an accidental rename of the typed symbol.
    expect(conversationStoreHandle).toBeDefined();
    // Touch the storage dump so the in-memory edge is exercised end-to-end.
    expect(store.dump().size).toBeGreaterThan(0);
  });

  it("resolves by stable id as well as by name", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
    ]);
    const list = await service.list();
    const id = list[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;

    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5"]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      agent: id,
      task: "do the thing",
    });
    expect(res.ok).toBe(true);
    const started = orchestrator.startTurnCalls[0];
    expect(started?.modelName).toBe("opencode-1/claude-sonnet-4.5");
  });

  it("performs ZERO catalog-validation calls on the Named Agent path", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
    ]);
    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5"]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    await svc.summon({
      callerConversationId: "caller-1",
      agent: "Coding Agent",
      task: "do the thing",
    });
    expect(cred.listCatalog).not.toHaveBeenCalled();
    expect(cred.getModelInfo).not.toHaveBeenCalled();
  });

  it("unknown Named Agent → unknown-agent error listing available names", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
      { id: "y", name: "Research Agent", model: "umans/umans-glm-5.2" },
    ]);
    const cred = makeFakeCredentialStore([]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      agent: "Nope Agent",
      task: "do the thing",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unknown-agent");
    expect(res.error.message).toContain("Nope Agent");
    expect(res.error.message).toContain("Coding Agent");
    expect(res.error.message).toContain("Research Agent");
    // No conversation was started.
    expect(orchestrator.startTurnCalls).toHaveLength(0);
  });

  it("unknown Named Agent with empty registry names the setup guidance", async () => {
    const { service } = await makeNamedAgents();
    const cred = makeFakeCredentialStore([]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      agent: "Ghost",
      task: "do the thing",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unknown-agent");
    expect(res.error.message).toContain("no named agents are configured");
  });

  it("editing/deleting a Named Agent does not mutate an existing snapshot", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
    ]);
    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5", "umans/umans-glm-5.2"]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      agent: "Coding Agent",
      task: "do the thing",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const childId = res.value.conversationId;
    const before = await deps.conversationStore.getNamedAgentSelection(childId);
    expect(before?.model).toBe("opencode-1/claude-sonnet-4.5");
    expect(before?.namedAgentName).toBe("Coding Agent");

    // Now edit the Named Agent's model + name, then delete it entirely.
    const list = await service.list();
    const id = list[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;
    await service.update(id, { name: "Renamed Agent", model: "umans/umans-glm-5.2" });
    await service.delete(id);

    // The frozen snapshot on the conversation is unchanged.
    const after = await deps.conversationStore.getNamedAgentSelection(childId);
    expect(after).toEqual(before);
  });
});

// ─── summon_agent: raw-model backward compatibility ──────────────────────────

describe("AgentManagementService.summon — raw model backward compatibility", () => {
  it("raw model path validates against the catalog and writes NO snapshot", async () => {
    const { service } = await makeNamedAgents();
    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5"]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      model: "opencode-1/claude-sonnet-4.5",
      task: "do the thing",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(cred.listCatalog).toHaveBeenCalledTimes(1);
    const started = orchestrator.startTurnCalls[0];
    expect(started?.modelName).toBe("opencode-1/claude-sonnet-4.5");
    // No snapshot on a raw-model conversation.
    const snap = await deps.conversationStore.getNamedAgentSelection(res.value.conversationId);
    expect(snap).toBeNull();
  });

  it("unknown raw model → unknown-model error (catalog-validated)", async () => {
    const { service } = await makeNamedAgents();
    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5"]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      model: "nope/missing",
      task: "do the thing",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unknown-model");
    expect(orchestrator.startTurnCalls).toHaveLength(0);
  });
});

// ─── summon_agent: exactly-one (agent XOR model) validation ──────────────────

describe("AgentManagementService.summon — exactly-one selection", () => {
  it("both agent and model → invalid-input", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
    ]);
    const cred = makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5"]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      agent: "Coding Agent",
      model: "opencode-1/claude-sonnet-4.5",
      task: "do the thing",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid-input");
    expect(orchestrator.startTurnCalls).toHaveLength(0);
  });

  it("neither agent nor model → invalid-input", async () => {
    const { service } = await makeNamedAgents();
    const cred = makeFakeCredentialStore([]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      task: "do the thing",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid-input");
  });

  it("whitespace-only agent/model counts as not supplied", async () => {
    const { service } = await makeNamedAgents();
    const cred = makeFakeCredentialStore([]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      agent: "   ",
      model: "  ",
      task: "do the thing",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid-input");
  });

  it("empty task → invalid-input", async () => {
    const { service } = await makeNamedAgents([
      { id: "x", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
    ]);
    const cred = makeFakeCredentialStore([]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "caller-1",
      agent: "Coding Agent",
      task: "   ",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid-input");
  });

  it("missing caller conversation id → invalid-input", async () => {
    const { service } = await makeNamedAgents();
    const cred = makeFakeCredentialStore([]);
    const orchestrator = makeFakeOrchestrator();
    const { deps } = makeDeps({ namedAgents: service, credentialStore: cred, orchestrator });
    const svc = createAgentManagementService(deps);

    const res = await svc.summon({
      callerConversationId: "",
      agent: "Coding Agent",
      task: "do the thing",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid-input");
  });
});

describe("agent-management visual grouping on open", () => {
  it("summon opens under the already-persisted lineage parent, and open_agent uses effective overrides", async () => {
    const { service } = await makeNamedAgents();
    const { deps } = makeDeps({
      namedAgents: service,
      credentialStore: makeFakeCredentialStore(["opencode-1/claude-sonnet-4.5"]),
    });
    const events: Array<{ hook: unknown; payload: unknown }> = [];
    const svc = createAgentManagementService({
      ...deps,
      emit: (hook, payload) => {
        events.push({ hook, payload });
      },
    });
    await deps.conversationStore.setWorkspaceId("caller-1", "work");
    const result = await svc.summon({
      callerConversationId: "caller-1",
      model: "opencode-1/claude-sonnet-4.5",
      task: "help",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conversationId = result.value.conversationId;
    expect(events).toEqual([
      {
        hook: conversationOpened,
        payload: {
          conversationId,
          workspaceId: "work",
          tabGroupParentId: "caller-1",
        },
      },
    ]);
    // The fake orchestrator deliberately does not persist metadata. Lineage
    // still precedes summon-open; ordinary open reads already-persisted state.
    await deps.conversationStore.setConversationTitle(conversationId, "child");
    await deps.conversationStore.setWorkspaceId(conversationId, "work");
    for (const parentId of ["visual-only", null]) {
      await deps.conversationStore.setTabGroupParentId(conversationId, parentId);
      expect((await svc.open({ callerConversationId: "caller-1", conversationId })).ok).toBe(true);
      expect(events.at(-1)).toEqual({
        hook: conversationOpened,
        payload: {
          conversationId,
          workspaceId: "work",
          ...(parentId !== null ? { tabGroupParentId: parentId } : {}),
        },
      });
      expect(await deps.conversationStore.getParentConversationId(conversationId)).toBe("caller-1");
    }
  });
});
