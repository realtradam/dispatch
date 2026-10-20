import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
/**
 * Service-level tests for the agent-management imperative shell (plan §14
 * backend). These exercise `listModels` + `summon` against the REAL
 * `@dispatch/named-agents` registry and the REAL `@dispatch/conversation-store`
 * (both backed by an in-memory StorageNamespace — the outermost edge), plus
 * focused fakes for the credential-store (the catalog edge) and the
 * session-orchestrator in the pre-existing summon tests. Messaging regressions
 * below instead use the REAL session-orchestrator, message-queue and kernel,
 * controlling only the provider edge. No `@dispatch/*` module is mocked.
 */

import { conversationStoreHandle, createConversationStore } from "@dispatch/conversation-store";
import type { CredentialStore } from "@dispatch/credential-store";
import {
  createLogger,
  type ProviderContract,
  runTurn,
  type StorageNamespace,
} from "@dispatch/kernel";
import { createNamedAgentsService, type NamedAgentsService } from "@dispatch/named-agents";
import {
  conversationOpened,
  createSessionOrchestrator,
  type SessionOrchestrator,
  type StartTurnInput,
} from "@dispatch/session-orchestrator";
import type { NamedAgent, NamedAgentSelectionSnapshot } from "@dispatch/wire";
import { describe, expect, it, vi } from "vitest";
// Public barrel: allows isolated tests before orchestrator-owned workspace relinking.
import { createMessageQueueService } from "../../message-queue/src/index.js";
import { type AgentManagementDeps, createAgentManagementService } from "./service.js";
import { createCancelAgentMessageTool, createSendAgentMessageTool } from "./tools/index.js";

// ─── in-memory StorageNamespace (the outermost edge) ────────────────────────

function makeStorage(): StorageNamespace & {
  readonly dump: () => ReadonlyMap<string, string>;
} {
  const map = new Map<string, string>();
  return {
    ...storageFromMap(map),
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

// Messaging regressions use REAL stores, orchestrator, queue and kernel turns.
// Only the outermost provider is controlled; all IDs/storage are synthetic and
// no production extension is activated, so these tests cannot contact agents.
const MESSAGE_IDS = {
  caller: "ca110000-0000-4000-8000-000000000001",
  parent: "face0000-0000-4000-8000-000000000002",
  sibling: "51b10000-0000-4000-8000-000000000003",
  unrelated: "beef0000-0000-4000-8000-000000000004",
  crossWorkspace: "c2050000-0000-4000-8000-000000000005",
  child: "c0110000-0000-4000-8000-000000000006",
  collision: "c0110000-0000-4000-8000-000000000007",
} as const;

async function makeMessagingFixture() {
  const { service: namedAgents } = await makeNamedAgents();
  const { deps } = makeDeps({
    namedAgents,
    credentialStore: makeFakeCredentialStore([]),
  });
  const store = deps.conversationStore;
  for (const [name, id] of Object.entries(MESSAGE_IDS)) {
    await store.setConversationTitle(id, name);
    await store.setWorkspaceId(id, name === "crossWorkspace" ? "other-workspace" : "default");
    await store.setModel(id, "test-model");
  }
  await store.setParentConversationId(MESSAGE_IDS.caller, MESSAGE_IDS.parent);
  await store.setParentConversationId(MESSAGE_IDS.sibling, MESSAGE_IDS.parent);
  await store.setParentConversationId(MESSAGE_IDS.child, MESSAGE_IDS.caller);
  await store.setCwd(MESSAGE_IDS.crossWorkspace, "/synthetic/target");
  await store.setComputerId(MESSAGE_IDS.crossWorkspace, "synthetic-computer");
  await store.setToolPolicy(MESSAGE_IDS.crossWorkspace, { mode: "none" });

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: Array<{
    messages: Parameters<ProviderContract["stream"]>[0];
    options: Parameters<ProviderContract["stream"]>[2];
  }> = [];
  const provider: ProviderContract = {
    id: "isolated-test-provider",
    async *stream(messages, _tools, options) {
      requests.push({ messages, options });
      await gate;
      yield { type: "text-delta", delta: "isolated reply" };
      yield { type: "finish", reason: "stop" };
    },
  };
  let queueId = 0;
  const queue = createMessageQueueService({
    id: () => `synthetic-message-${++queueId}`,
    now: () => 0,
    notify: () => {},
  });
  const { orchestrator } = createSessionOrchestrator({
    conversationStore: store,
    resolveProvider: () => provider,
    resolveTools: () => [],
    resolveQueue: () => queue,
    applyToolsFilter: async (assembly) => assembly,
    runTurn,
    logger: deps.logger,
  });
  const events: Array<{ hook: unknown; payload: unknown }> = [];
  const fileReads: Array<{ path: string; cwd: string | undefined }> = [];
  const svc = createAgentManagementService({
    ...deps,
    resolveOrchestrator: () => orchestrator,
    readFileContent: async (path, cwd) => {
      fileReads.push({ path, cwd });
      return "synthetic attachment";
    },
    emit: (hook, payload) => events.push({ hook, payload }),
  });
  async function finish() {
    release();
    await vi.waitFor(() => expect(orchestrator.getActiveConversationCount()).toBe(0));
  }
  return {
    svc,
    store,
    orchestrator,
    queue,
    requests,
    events,
    fileReads,
    finish,
    logger: deps.logger,
  };
}

describe("AgentManagementService — globally resolved messaging", () => {
  for (const [name, targetId, targetInput] of [
    ["parent full ID", MESSAGE_IDS.parent, MESSAGE_IDS.parent],
    ["parent 8-character prefix", MESSAGE_IDS.parent, MESSAGE_IDS.parent.slice(0, 8)],
    ["parent 4-character prefix", MESSAGE_IDS.parent, MESSAGE_IDS.parent.slice(0, 4)],
    ["sibling", MESSAGE_IDS.sibling, MESSAGE_IDS.sibling.slice(0, 4)],
    ["unrelated root", MESSAGE_IDS.unrelated, MESSAGE_IDS.unrelated],
    ["cross-workspace root", MESSAGE_IDS.crossWorkspace, MESSAGE_IDS.crossWorkspace.slice(0, 8)],
  ] as const) {
    it(`delivers to ${name}: idle start, active queue, cancel and idempotent re-cancel`, async () => {
      const f = await makeMessagingFixture();
      try {
        expect(
          await f.svc.send({
            callerConversationId: MESSAGE_IDS.caller,
            conversationId: targetInput,
            message: "synthetic opening",
          }),
        ).toEqual({ ok: true, value: { conversationId: targetId, delivered: "started-turn" } });
        await vi.waitFor(() => expect(f.requests).toHaveLength(1));
        expect(f.requests[0]?.messages.at(-1)?.chunks).toContainEqual({
          type: "text",
          text: "synthetic opening",
        });
        expect(f.events).toEqual([]);
        const sent = await f.svc.send({
          callerConversationId: MESSAGE_IDS.caller,
          conversationId: targetInput,
          message: "synthetic queued message",
        });
        expect(sent).toMatchObject({
          ok: true,
          value: { conversationId: targetId, delivered: "queued" },
        });
        if (!sent.ok || sent.value.messageId === undefined)
          throw new Error("expected queued message");
        expect(f.queue.getQueue(targetId)).toHaveLength(1);
        expect(f.requests).toHaveLength(1);
        const cancelInput = {
          callerConversationId: MESSAGE_IDS.caller,
          conversationId: targetInput,
          messageId: sent.value.messageId,
        };
        expect(await f.svc.cancelMessage(cancelInput)).toEqual({
          ok: true,
          value: { conversationId: targetId, cancelled: true, queueLength: 0 },
        });
        expect(await f.svc.cancelMessage(cancelInput)).toEqual({
          ok: true,
          value: { conversationId: targetId, cancelled: false, queueLength: 0 },
        });
        expect(f.queue.getQueue(targetId)).toEqual([]);
      } finally {
        await f.finish();
      }
      expect(f.requests).toHaveLength(1);
    });
  }

  for (const [input, code] of [
    ["missing-conversation", "unknown-conversation"],
    ["fac", "invalid-input"],
    ["c011", "ambiguous-conversation"],
    ["c0110000", "ambiguous-conversation"],
  ] as const) {
    it(`rejects ${input} globally with ${code} and no delivery/cancellation`, async () => {
      const f = await makeMessagingFixture();
      const preserved = f.queue.enqueue(MESSAGE_IDS.child, "preserve this synthetic message");
      const messageId = preserved[0]?.id;
      if (messageId === undefined) throw new Error("expected seeded queue");
      const before = await f.store.listConversations();
      const send = await f.svc.send({
        callerConversationId: MESSAGE_IDS.caller,
        conversationId: input,
        message: "must not be delivered",
        files: ["must-not-read.txt"],
        open: true,
      });
      const cancel = await f.svc.cancelMessage({
        callerConversationId: MESSAGE_IDS.caller,
        conversationId: input,
        messageId,
      });
      for (const result of [send, cancel]) {
        expect(result).toMatchObject({ ok: false, error: { code } });
        if (code === "ambiguous-conversation") {
          if (result.ok) throw new Error("expected ambiguity");
          expect(result.error.candidates).toHaveLength(2);
          expect(result.error.candidates).toEqual(
            expect.arrayContaining([MESSAGE_IDS.child, MESSAGE_IDS.collision]),
          );
        }
      }
      expect(f.requests).toEqual([]);
      expect(f.orchestrator.getActiveConversationCount()).toBe(0);
      expect(f.events).toEqual([]);
      expect(f.fileReads).toEqual([]);
      expect(f.queue.getQueue(MESSAGE_IDS.child)).toEqual(preserved);
      expect(await f.store.listConversations()).toEqual(before);
    });
  }

  it("preserves self-target safety for send and cancel by full ID and prefixes", async () => {
    const f = await makeMessagingFixture();
    const preserved = f.queue.enqueue(MESSAGE_IDS.caller, "self queue remains untouched");
    for (const conversationId of [
      MESSAGE_IDS.caller,
      MESSAGE_IDS.caller.slice(0, 8),
      MESSAGE_IDS.caller.slice(0, 4),
    ]) {
      expect(
        await f.svc.send({
          callerConversationId: MESSAGE_IDS.caller,
          conversationId,
          message: "self",
        }),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(
        await f.svc.cancelMessage({
          callerConversationId: MESSAGE_IDS.caller,
          conversationId,
          messageId: preserved[0]?.id ?? "missing",
        }),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(f.queue.getQueue(MESSAGE_IDS.caller)).toEqual(preserved);
    expect(f.requests).toEqual([]);
    expect(f.orchestrator.getActiveConversationCount()).toBe(0);
  });

  it("preserves read/open lineage restrictions and local prefix resolution", async () => {
    const f = await makeMessagingFixture();
    for (const targetId of [
      MESSAGE_IDS.parent,
      MESSAGE_IDS.sibling,
      MESSAGE_IDS.unrelated,
      MESSAGE_IDS.crossWorkspace,
    ]) {
      for (const conversationId of [targetId, targetId.slice(0, 8), targetId.slice(0, 4)]) {
        for (const operation of ["read", "open"] as const) {
          expect(
            await f.svc[operation]({ callerConversationId: MESSAGE_IDS.caller, conversationId }),
          ).toMatchObject({
            ok: false,
            error: { code: conversationId === targetId ? "forbidden" : "unknown-conversation" },
          });
        }
      }
    }
    expect(f.events).toEqual([]);
    // A non-descendant collision is ambiguous for messaging, NOT for read/open.
    for (const conversationId of [MESSAGE_IDS.child, "c011", "c0110000", MESSAGE_IDS.caller]) {
      for (const operation of ["read", "open"] as const) {
        expect(
          (await f.svc[operation]({ callerConversationId: MESSAGE_IDS.caller, conversationId })).ok,
        ).toBe(true);
      }
    }
    expect(f.requests).toEqual([]);
  });

  it("preserves children/descendants/workspace list scope and the legacy descendant flag", async () => {
    const f = await makeMessagingFixture();
    for (const relationship of [undefined, "descendants"] as const) {
      const listed = await f.svc.list({
        callerConversationId: MESSAGE_IDS.caller,
        ...(relationship !== undefined ? { relationship } : {}),
      });
      expect(listed).toMatchObject({
        ok: true,
        value: { agents: [{ conversationId: MESSAGE_IDS.child, manageable: true }] },
      });
      if (!listed.ok) throw new Error("expected list");
      expect(listed.value.agents).toHaveLength(1);
    }
    const listed = await f.svc.list({
      callerConversationId: MESSAGE_IDS.caller,
      relationship: "workspace",
    });
    if (!listed.ok) throw new Error("expected workspace list");
    expect(listed.value.agents).toHaveLength(6);
    expect(
      listed.value.agents.find((agent) => agent.conversationId === MESSAGE_IDS.unrelated)
        ?.manageable,
    ).toBe(false);
    expect(
      listed.value.agents.some((agent) => agent.conversationId === MESSAGE_IDS.crossWorkspace),
    ).toBe(false);
  });

  it("preserves idle wait, target context, file composition and send-open across workspaces", async () => {
    const f = await makeMessagingFixture();
    try {
      const waiting = f.svc.send({
        callerConversationId: MESSAGE_IDS.caller,
        conversationId: MESSAGE_IDS.crossWorkspace,
        message: "synthetic task",
        files: ["fixture.txt"],
        wait: true,
        open: true,
      });
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      expect(f.fileReads).toEqual([{ path: "fixture.txt", cwd: "/synthetic/target" }]);
      expect(f.requests[0]?.messages.at(-1)?.chunks).toContainEqual({
        type: "text",
        text: expect.stringContaining("synthetic attachment"),
      });
      expect(f.events).toEqual([
        {
          hook: conversationOpened,
          payload: {
            conversationId: MESSAGE_IDS.crossWorkspace,
            workspaceId: "other-workspace",
            model: "test-model",
          },
        },
      ]);
      await f.finish();
      expect(await waiting).toEqual({
        ok: true,
        value: {
          conversationId: MESSAGE_IDS.crossWorkspace,
          delivered: "started-turn",
          reply: "isolated reply",
        },
      });
      expect(await f.store.getWorkspaceId(MESSAGE_IDS.crossWorkspace)).toBe("other-workspace");
      expect(await f.store.getComputerId(MESSAGE_IDS.crossWorkspace)).toBe("synthetic-computer");
      expect(await f.store.getModel(MESSAGE_IDS.crossWorkspace)).toBe("test-model");
      expect(await f.store.getToolPolicy(MESSAGE_IDS.crossWorkspace)).toEqual({ mode: "none" });
    } finally {
      await f.finish();
    }
  });

  it("preserves queued wait rejection after enqueueing, without waiting or opening", async () => {
    const f = await makeMessagingFixture();
    try {
      await f.svc.send({
        callerConversationId: MESSAGE_IDS.caller,
        conversationId: MESSAGE_IDS.sibling,
        message: "opening",
      });
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      expect(
        await f.svc.send({
          callerConversationId: MESSAGE_IDS.caller,
          conversationId: MESSAGE_IDS.sibling,
          message: "queued",
          wait: true,
          open: true,
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "invalid-input",
          message: expect.stringContaining(
            "read_agent only if the target is within your separate read scope (descendants and self)",
          ),
        },
      });
      expect(f.queue.getQueue(MESSAGE_IDS.sibling)).toHaveLength(1);
      expect(f.events).toEqual([]);
      f.queue.drain(MESSAGE_IDS.sibling);
    } finally {
      await f.finish();
    }
  });
});

describe("messaging tools — isolated caller identity and validation", () => {
  it("uses caller context, not forged arguments, for global send and cancellation", async () => {
    const f = await makeMessagingFixture();
    const context = {
      conversationId: MESSAGE_IDS.caller,
      toolCallId: "synthetic-tool-call",
      signal: new AbortController().signal,
      onOutput: () => {},
      log: f.logger,
    };
    try {
      const send = createSendAgentMessageTool(f.svc);
      // Forged caller == target would forbid delivery if trusted.
      const args = {
        callerConversationId: MESSAGE_IDS.parent,
        conversationId: MESSAGE_IDS.parent.slice(0, 4),
        message: "synthetic tool message",
      };
      expect((await send.execute(args, context)).isError).not.toBe(true);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      expect((await send.execute(args, context)).content).toContain("Message queued");
      const messageId = f.queue.getQueue(MESSAGE_IDS.parent)[0]?.id;
      if (messageId === undefined) throw new Error("expected tool-queued message");
      const cancelled = await createCancelAgentMessageTool(f.svc).execute(
        {
          callerConversationId: MESSAGE_IDS.parent,
          conversationId: MESSAGE_IDS.parent.slice(0, 8),
          messageId,
        },
        context,
      );
      expect(cancelled.isError).not.toBe(true);
      expect(cancelled.content).toContain("Cancelled queued message");
      expect(f.queue.getQueue(MESSAGE_IDS.parent)).toEqual([]);
    } finally {
      await f.finish();
    }
  });

  it("rejects missing caller, empty target/message/messageId before any delivery", async () => {
    const f = await makeMessagingFixture();
    for (const input of [
      { callerConversationId: "", conversationId: MESSAGE_IDS.parent, message: "text" },
      { callerConversationId: MESSAGE_IDS.caller, conversationId: "", message: "text" },
      {
        callerConversationId: MESSAGE_IDS.caller,
        conversationId: MESSAGE_IDS.parent,
        message: "  ",
      },
    ]) {
      expect(await f.svc.send(input)).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
    }
    for (const input of [
      { callerConversationId: "", conversationId: MESSAGE_IDS.parent, messageId: "message" },
      { callerConversationId: MESSAGE_IDS.caller, conversationId: "", messageId: "message" },
      {
        callerConversationId: MESSAGE_IDS.caller,
        conversationId: MESSAGE_IDS.parent,
        messageId: "",
      },
    ]) {
      expect(await f.svc.cancelMessage(input)).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
    }
    expect(f.requests).toEqual([]);
    expect(f.orchestrator.getActiveConversationCount()).toBe(0);
  });

  it("aborting a global send wait does not stop the target", async () => {
    const f = await makeMessagingFixture();
    const controller = new AbortController();
    try {
      const waiting = f.svc.send({
        callerConversationId: MESSAGE_IDS.caller,
        conversationId: MESSAGE_IDS.parent,
        message: "synthetic waiting",
        wait: true,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      controller.abort();
      expect(await waiting).toEqual({
        ok: true,
        value: {
          conversationId: MESSAGE_IDS.parent,
          delivered: "started-turn",
          waitCancelled: true,
        },
      });
      expect(f.orchestrator.isActive(MESSAGE_IDS.parent)).toBe(true);
    } finally {
      await f.finish();
    }
  });
});

describe("global messaging resolution edge cases", () => {
  it("includes cross-workspace and self collisions instead of silently selecting a descendant", async () => {
    const f = await makeMessagingFixture();
    await f.store.setWorkspaceId(MESSAGE_IDS.collision, "other-workspace");
    const selfCollision = `${MESSAGE_IDS.caller.slice(0, 8)}-synthetic-collision`;
    await f.store.setConversationTitle(selfCollision, "synthetic caller-prefix collision");
    for (const conversationId of ["c0110000", MESSAGE_IDS.caller.slice(0, 8)]) {
      const sent = await f.svc.send({
        callerConversationId: MESSAGE_IDS.caller,
        conversationId,
        message: "must not deliver",
      });
      const cancelled = await f.svc.cancelMessage({
        callerConversationId: MESSAGE_IDS.caller,
        conversationId,
        messageId: "must not cancel",
      });
      for (const result of [sent, cancelled]) {
        expect(result).toMatchObject({ ok: false, error: { code: "ambiguous-conversation" } });
        if (result.ok) throw new Error("expected global ambiguity");
        expect(result.error.candidates).toHaveLength(2);
      }
    }
    expect(f.requests).toEqual([]);
    expect(f.orchestrator.getActiveConversationCount()).toBe(0);
  });

  it("resolves a closed unrelated conversation without a lifecycle filter", async () => {
    const f = await makeMessagingFixture();
    await f.store.setConversationStatus(MESSAGE_IDS.unrelated, "closed");
    try {
      expect(
        await f.svc.send({
          callerConversationId: MESSAGE_IDS.caller,
          conversationId: MESSAGE_IDS.unrelated.slice(0, 4),
          message: "synthetic reopen",
        }),
      ).toMatchObject({
        ok: true,
        value: { conversationId: MESSAGE_IDS.unrelated, delivered: "started-turn" },
      });
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    } finally {
      await f.finish();
    }
  });
});
