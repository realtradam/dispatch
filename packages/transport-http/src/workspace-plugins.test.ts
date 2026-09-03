import type { Logger } from "@dispatch/kernel";
import type {
  ModelsResponse,
  SetWorkspacePluginStateResponse,
  WorkspacePluginProvidersStatusResponse,
  WorkspacePluginsResponse,
} from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type {
  ConversationStore,
  CredentialStore,
  PluginOwnership,
  WorkspacePluginConfigService,
} from "./seam.js";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
  span() {
    return {
      id: "noop",
      log: noopLogger,
      setAttributes() {},
      addLink() {},
      child() {
        return this;
      },
      end() {},
    };
  },
};

/** Minimal store fake — these routes never touch it. */
function fakeStore(): ConversationStore {
  return {} as ConversationStore;
}

/** The state table a fake config service reads (workspaceId/pluginId → state). */
type StateTable = Map<string, "enabled" | "disabled" | undefined>;

/**
 * A plain in-memory WorkspacePluginConfigService realization (no mocks —
 * the same shape the real service presents, backed by a Map). `stateOf`
 * materializes nothing; the view path returns a scripted row set.
 */
function fakeConfigService(
  states: StateTable,
  overrides: Partial<WorkspacePluginConfigService> = {},
): WorkspacePluginConfigService {
  return {
    async stateOf(workspaceId, pluginId) {
      return states.get(`${workspaceId}/${pluginId}`);
    },
    async effectiveStates(workspaceId) {
      const out = new Map<string, "enabled" | "disabled" | undefined>();
      for (const [key, state] of states) {
        const [ws, pluginId] = key.split("/") as [string, string];
        if (ws === workspaceId) out.set(pluginId, state);
      }
      return out;
    },
    async view(workspaceId) {
      const plugins = [...states]
        .filter(([key]) => (key.split("/") as [string, string])[0] === workspaceId)
        .map(([key, state]) => {
          const pluginId = (key.split("/") as [string, string])[1];
          return {
            pluginId,
            tier: "standard" as const,
            state: state ?? ("undefined" as const),
            loaded: true,
            locked: false,
          };
        });
      return { plugins, enabledProviderCount: 0 };
    },
    ...overrides,
  } as WorkspacePluginConfigService;
}

/** A plain PluginOwnership realization over a scripted ledger table. */
function fakeOwnership(table: ReadonlyMap<string, string>): PluginOwnership {
  return {
    ownerOfTool: (toolName) => table.get(toolName),
    ownerOfProvider: (providerId) => table.get(providerId),
  };
}

interface CatalogSeed {
  readonly name: string;
  readonly providerId: string;
  readonly contextWindow?: number;
  readonly vision?: boolean;
}

/** A CredentialStore fake over a scripted catalog + resolve table. */
function fakeCredentials(seeds: readonly CatalogSeed[]): CredentialStore {
  return {
    resolve(modelName) {
      const credential = modelName.split("/")[0];
      const seed = seeds.find((s) => s.name === credential);
      return seed
        ? { providerId: seed.providerId, model: modelName.split("/").slice(1).join("/") }
        : undefined;
    },
    async listCatalog() {
      return seeds.map((s) => `${s.name}/model-1`);
    },
    async listCatalogDetailed() {
      return seeds.map((s) => ({
        name: `${s.name}/model-1`,
        info: {
          id: "model-1",
          ...(s.contextWindow !== undefined ? { contextWindow: s.contextWindow } : {}),
          ...(s.vision === true ? { vision: true } : {}),
        },
      }));
    },
    async getModelInfo() {
      return undefined;
    },
  } as unknown as CredentialStore;
}

function appWith(opts: {
  readonly configService?: WorkspacePluginConfigService;
  readonly ownership?: PluginOwnership;
  readonly seeds?: readonly CatalogSeed[];
}) {
  return createApp({
    conversationStore: fakeStore(),
    orchestrator: {} as never,
    credentialStore: fakeCredentials(opts.seeds ?? []),
    logger: noopLogger,
    ...(opts.configService !== undefined
      ? { workspacePluginConfigService: opts.configService }
      : {}),
    ...(opts.ownership !== undefined ? { pluginOwnership: opts.ownership } : {}),
    ...(opts.seeds !== undefined
      ? {
          pluginTierOf: (pluginId: string) =>
            pluginId === "provider-umans" || pluginId === "mcp"
              ? ("providers" as const)
              : pluginId === "kernel-core"
                ? ("core" as const)
                : undefined,
        }
      : {}),
  });
}

// ─── GET /workspaces/:id/plugins ─────────────────────────────────────────────

describe("GET /workspaces/:id/plugins", () => {
  it("returns effective states + metadata (200); reading is the materialization trigger (service-side)", async () => {
    const app = appWith({
      configService: fakeConfigService(new Map([["team-a/provider-umans", "enabled"]])),
    });
    const res = await app.request("/workspaces/team-a/plugins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspacePluginsResponse;
    expect(body.workspaceId).toBe("team-a");
    const row = body.plugins.find((p) => p.pluginId === "provider-umans");
    expect(row).toMatchObject({ pluginId: "provider-umans", state: "enabled" });
  });

  it("returns 503 when the workspace-plugin-config service is absent", async () => {
    const res = await appWith({}).request("/workspaces/team-a/plugins");
    expect(res.status).toBe(503);
  });
});

// ─── GET /workspaces/:id/plugins/providers-status ────────────────────────────

describe("GET /workspaces/:id/plugins/providers-status", () => {
  it("reports the enabledProviderCount (the §7 zero-enabled guardrail signal)", async () => {
    const app = appWith({
      configService: fakeConfigService(new Map(), {
        async enabledProviderCount() {
          return 0;
        },
      }),
    });
    const res = await app.request("/workspaces/team-a/plugins/providers-status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspacePluginProvidersStatusResponse;
    expect(body).toEqual({ workspaceId: "team-a", enabledProviderCount: 0 });
  });

  it("returns 503 when the service is absent", async () => {
    const res = await appWith({}).request("/workspaces/team-a/plugins/providers-status");
    expect(res.status).toBe(503);
  });
});

// ─── PUT /workspaces/:id/plugins/:pluginId ───────────────────────────────────

describe("PUT /workspaces/:id/plugins/:pluginId", () => {
  function setStateRecording(states: StateTable) {
    const calls: { workspaceId: string; pluginId: string; state: string }[] = [];
    const service = fakeConfigService(states, {
      async setState(workspaceId, pluginId, state) {
        calls.push({ workspaceId, pluginId, state });
        if (state === "unset") {
          states.delete(`${workspaceId}/${pluginId}`);
          return { ok: true, state: undefined };
        }
        states.set(`${workspaceId}/${pluginId}`, state);
        return { ok: true, state };
      },
    });
    return { service, calls };
  }

  it("sets a state (200) and reports the resulting effective state", async () => {
    const states: StateTable = new Map();
    const { service } = setStateRecording(states);
    const app = appWith({ configService: service });
    const res = await app.request("/workspaces/team-a/plugins/mcp", {
      method: "PUT",
      body: JSON.stringify({ state: "disabled" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetWorkspacePluginStateResponse;
    expect(body).toEqual({ workspaceId: "team-a", pluginId: "mcp", state: "disabled" });
  });

  it('"unset" returns the plugin to the blank slate ("undefined")', async () => {
    const states: StateTable = new Map([["team-a/mcp", "enabled"]]);
    const { service } = setStateRecording(states);
    const app = appWith({ configService: service });
    const res = await app.request("/workspaces/team-a/plugins/mcp", {
      method: "PUT",
      body: JSON.stringify({ state: "unset" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetWorkspacePluginStateResponse;
    expect(body.state).toBe("undefined");
  });

  it("refuses an UNLOADED or CORE plugin with 409 + reason", async () => {
    const service = fakeConfigService(new Map(), {
      async setState(_workspaceId, _pluginId, _state) {
        return { ok: false, reason: "core-locked" };
      },
    });
    const app = appWith({ configService: service });
    const res = await app.request("/workspaces/team-a/plugins/kernel-core", {
      method: "PUT",
      body: JSON.stringify({ state: "disabled" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason: string; pluginId: string };
    expect(body.reason).toBe("core-locked");
    expect(body.pluginId).toBe("kernel-core");
  });

  it("rejects an invalid body with 400 (missing/unknown state)", async () => {
    const states: StateTable = new Map();
    const { service } = setStateRecording(states);
    const app = appWith({ configService: service });
    const res = await app.request("/workspaces/team-a/plugins/mcp", {
      method: "PUT",
      body: JSON.stringify({ state: "banana" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const app = appWith({ configService: fakeConfigService(new Map()) });
    const res = await app.request("/workspaces/team-a/plugins/mcp", {
      method: "PUT",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when the service is absent", async () => {
    const res = await appWith({}).request("/workspaces/team-a/plugins/mcp", {
      method: "PUT",
      body: JSON.stringify({ state: "enabled" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(503);
  });
});

// ─── GET /models?workspaceId= (plan 06 §6.5) ────────────────────────────────

describe("GET /models workspace filtering", () => {
  const seeds = [
    { name: "umans", providerId: "umans", contextWindow: 128000 },
    { name: "opencode-1", providerId: "opencode-1" },
  ];

  it("NO param → the global catalog (backward compatible, no services needed)", async () => {
    const app = appWith({ seeds });
    const res = await app.request("/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsResponse;
    expect(body.models).toEqual(["umans/model-1", "opencode-1/model-1"]);
  });

  it("with workspaceId → entries from providers NOT usable in that workspace are omitted", async () => {
    // Ledger: `umans` is owned by provider-umans (disabled in team-a);
    // `opencode-1` has no attributable owner (fail-open → kept).
    const ownership = fakeOwnership(
      new Map([
        ["umans", "provider-umans"],
        ["myserver__q", "mcp"],
      ]),
    );
    const configService = fakeConfigService(new Map([["team-a/provider-umans", "disabled"]]));
    const app = appWith({ seeds, ownership, configService });
    const res = await app.request("/models?workspaceId=team-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsResponse;
    expect(body.models).toEqual(["opencode-1/model-1"]);
  });

  it("with workspaceId → entries from USABLE providers stay (enabled / core / unclassifiable)", async () => {
    const ownership = fakeOwnership(new Map([["umans", "provider-umans"]]));
    const configService = fakeConfigService(new Map([["team-a/provider-umans", "enabled"]]));
    const app = appWith({ seeds, ownership, configService });
    const res = await app.request("/models?workspaceId=team-a");
    const body = (await res.json()) as ModelsResponse;
    expect(body.models).toEqual(["umans/model-1", "opencode-1/model-1"]);
  });

  it("with workspaceId but services ABSENT → 503 (never silently unfiltered)", async () => {
    const app = appWith({ seeds });
    const res = await app.request("/models?workspaceId=team-a");
    expect(res.status).toBe(503);
  });

  it("with workspaceId → modelInfo metadata is preserved for the surviving entries", async () => {
    const ownership = fakeOwnership(new Map([["umans", "provider-umans"]]));
    const configService = fakeConfigService(new Map([["team-a/provider-umans", "enabled"]]));
    const app = appWith({ seeds, ownership, configService });
    const res = await app.request("/models?workspaceId=team-a");
    const body = (await res.json()) as ModelsResponse;
    expect(body.modelInfo).toEqual({ "umans/model-1": { contextWindow: 128000 } });
  });
});
