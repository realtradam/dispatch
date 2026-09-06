import type { Logger } from "@dispatch/kernel";
import type {
  PluginListResponse,
  PluginOpResponse,
  PluginScanResponse,
} from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type {
  ConversationStore,
  CredentialStore,
  FrontendEntryResult,
  PluginManagerService,
} from "./seam.js";

/** Minimal store/credential fakes — the plugin routes never touch them. */
function fakeStore(): ConversationStore {
  return {} as ConversationStore;
}
function fakeCredentials(): CredentialStore {
  return {
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
  } as unknown as CredentialStore;
}
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

const fakeList: PluginListResponse = {
  loaded: [
    {
      id: "tool-fs",
      name: "Tool FS",
      version: "1.0.0",
      tier: "standard",
      trust: "bundled",
      locked: false,
      dependsOn: [],
    },
    {
      id: "storage-sqlite",
      name: "Storage SQLite",
      version: "1.0.0",
      tier: "core",
      trust: "bundled",
      locked: true,
      dependsOn: [],
    },
  ],
  disabledWithReason: [],
  discovered: [],
  missing: [],
};

const fakeScan: PluginScanResponse = {
  root: "/plugins",
  newPlugins: [
    {
      id: "new-one",
      name: "New One",
      version: "0.1.0",
      tier: "standard",
      trust: "local",
      dir: "/plugins/new-one",
    },
  ],
  invalid: [],
  incompatible: [],
};

/** A PluginManagerService fake recording ops and replaying scripted results. */
function fakeService(
  overrides: {
    readonly list?: () => Promise<PluginListResponse>;
    readonly scan?: () => Promise<PluginScanResponse>;
    readonly load?: (id: string) => Promise<PluginOpResponse>;
    readonly unload?: (id: string, opts?: { force?: boolean }) => Promise<PluginOpResponse>;
    readonly reload?: (id: string, opts?: { force?: boolean }) => Promise<PluginOpResponse>;
    readonly forget?: (id: string) => Promise<PluginOpResponse>;
    readonly frontendEntry?: (id: string, workspaceId?: string) => Promise<FrontendEntryResult>;
  } = {},
): PluginManagerService & {
  readonly calls: { readonly unload: { id: string; force: boolean }[] };
} {
  const calls: { unload: { id: string; force: boolean }[] } = { unload: [] };
  return {
    calls,
    list: overrides.list ?? (async () => fakeList),
    scan: overrides.scan ?? (async () => fakeScan),
    load:
      overrides.load ?? (async (id) => ({ ok: true, action: "load", id, clearedOverride: true })),
    unload:
      overrides.unload ??
      (async (id, opts) => {
        calls.unload.push({ id, force: opts?.force === true });
        return { ok: true, action: "unload", id };
      }),
    reload: overrides.reload ?? (async (id) => ({ ok: true, action: "reload", id })),
    forget:
      overrides.forget ??
      (async (id) => ({ ok: true, action: "forget", id, clearedOverride: true })),
    frontendEntry: overrides.frontendEntry ?? (async () => ({ ok: false, reason: "not-found" })),
  };
}

function appWith(svc?: PluginManagerService) {
  return createApp({
    conversationStore: fakeStore(),
    orchestrator: {} as never,
    credentialStore: fakeCredentials(),
    logger: noopLogger,
    ...(svc !== undefined ? { pluginManagerService: svc } : {}),
  });
}

// ─── GET /plugins ────────────────────────────────────────────────────────────

describe("GET /plugins", () => {
  it("returns the manager list (200)", async () => {
    const res = await appWith(fakeService()).request("/plugins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginListResponse;
    expect(body.loaded.map((r) => r.id)).toEqual(["tool-fs", "storage-sqlite"]);
    expect(body.loaded[1]?.locked).toBe(true);
  });

  it("returns 503 when the manager service is absent", async () => {
    const res = await appWith().request("/plugins");
    expect(res.status).toBe(503);
  });
});

// ─── POST /plugins/scan ─────────────────────────────────────────────────────

describe("POST /plugins/scan", () => {
  it("returns the scan response (200)", async () => {
    const res = await appWith(fakeService()).request("/plugins/scan", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginScanResponse;
    expect(body.newPlugins.map((p) => p.id)).toEqual(["new-one"]);
  });

  it("returns 503 when the manager service is absent", async () => {
    const res = await appWith().request("/plugins/scan", { method: "POST" });
    expect(res.status).toBe(503);
  });
});

// ─── POST /plugins/:id/load ─────────────────────────────────────────────────

describe("POST /plugins/:id/load", () => {
  it("delegates to the service (200)", async () => {
    const res = await appWith(fakeService()).request("/plugins/new-one/load", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginOpResponse;
    expect(body).toMatchObject({ ok: true, action: "load", id: "new-one" });
  });

  it("maps not-found to 404", async () => {
    const svc = fakeService({
      load: async (id) => ({
        ok: false,
        action: "load",
        id,
        reason: "not-found",
        message: "no loadable plugin",
      }),
    });
    const res = await appWith(svc).request("/plugins/ghost/load", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("maps blocked results to 409 with the reason + dependents", async () => {
    const svc = fakeService({
      load: async (id) => ({
        ok: false,
        action: "load",
        id,
        reason: "already-loaded",
        message: "already loaded — use reload",
      }),
    });
    const res = await appWith(svc).request("/plugins/live/load", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as PluginOpResponse;
    expect(body).toMatchObject({ ok: false, reason: "already-loaded" });
  });

  it("returns 503 when the manager service is absent", async () => {
    const res = await appWith().request("/plugins/x/load", { method: "POST" });
    expect(res.status).toBe(503);
  });
});

// ─── POST /plugins/:id/unload ───────────────────────────────────────────────

describe("POST /plugins/:id/unload", () => {
  it("forwards force from the JSON body", async () => {
    const svc = fakeService();
    const res = await appWith(svc).request("/plugins/tool-fs/unload", {
      method: "POST",
      body: JSON.stringify({ force: true }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(svc.calls.unload).toEqual([{ id: "tool-fs", force: true }]);
  });

  it("treats an ABSENT body as force: false", async () => {
    const svc = fakeService();
    const res = await appWith(svc).request("/plugins/tool-fs/unload", { method: "POST" });
    expect(res.status).toBe(200);
    expect(svc.calls.unload).toEqual([{ id: "tool-fs", force: false }]);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await appWith(fakeService()).request("/plugins/tool-fs/unload", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean force with 400", async () => {
    const res = await appWith(fakeService()).request("/plugins/tool-fs/unload", {
      method: "POST",
      body: JSON.stringify({ force: "yes" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("maps the cascade-needs-force block to 409 with dependents", async () => {
    const svc = fakeService({
      unload: async (id) => ({
        ok: false,
        action: "unload",
        id,
        reason: "cascade-needs-force",
        message: "1 loaded plugin(s) depend on it",
        dependents: ["dependent"],
      }),
    });
    const res = await appWith(svc).request("/plugins/base/unload", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as PluginOpResponse;
    expect(body).toMatchObject({
      ok: false,
      reason: "cascade-needs-force",
      dependents: ["dependent"],
    });
  });

  it("maps the core-locked and last-provider blocks to 409", async () => {
    for (const reason of ["core-locked", "last-provider"] as const) {
      const svc = fakeService({
        unload: async (id) => ({ ok: false, action: "unload", id, reason, message: reason }),
      });
      const res = await appWith(svc).request("/plugins/x/unload", { method: "POST" });
      expect(res.status).toBe(409);
    }
  });

  it("returns 503 when the manager service is absent", async () => {
    const res = await appWith().request("/plugins/x/unload", { method: "POST" });
    expect(res.status).toBe(503);
  });
});

// ─── POST /plugins/:id/reload ───────────────────────────────────────────────

describe("POST /plugins/:id/reload", () => {
  it("delegates with force from the body (200)", async () => {
    const svc = fakeService({
      reload: async (id) => ({
        ok: true,
        action: "reload",
        id,
        reloadedDependents: ["dep"],
        stoppedAgents: 2,
      }),
    });
    const res = await appWith(svc).request("/plugins/tool-fs/reload", {
      method: "POST",
      body: JSON.stringify({ force: true }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginOpResponse;
    expect(body).toMatchObject({
      ok: true,
      action: "reload",
      reloadedDependents: ["dep"],
      stoppedAgents: 2,
    });
  });

  it("returns 503 when the manager service is absent", async () => {
    const res = await appWith().request("/plugins/x/reload", { method: "POST" });
    expect(res.status).toBe(503);
  });
});

// ─── POST /plugins/:id/forget ───────────────────────────────────────────────

describe("POST /plugins/:id/forget", () => {
  it("delegates to the service (200)", async () => {
    const res = await appWith(fakeService()).request("/plugins/gone/forget", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginOpResponse;
    expect(body).toMatchObject({ ok: true, action: "forget", id: "gone", clearedOverride: true });
  });

  it("returns 503 when the manager service is absent", async () => {
    const res = await appWith().request("/plugins/x/forget", { method: "POST" });
    expect(res.status).toBe(503);
  });
});

// ─── GET /plugins/:id/frontend (plan 03 §3.1) ───────────────────────────────

describe("GET /plugins/:id/frontend", () => {
  it("serves the entry bytes as text/javascript", async () => {
    const svc = fakeService({
      frontendEntry: async () => ({ ok: true, code: "export default 1;\n", bust: "1727100000000" }),
    });
    const res = await appWith(svc).request(
      "/plugins/with-fe/frontend?workspace=team-a&v=1727100000000",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(await res.text()).toBe("export default 1;\n");
  });

  it("passes the workspace query to the service (the caller's ACTIVE workspace)", async () => {
    let seen: { id: string; workspaceId?: string } | undefined;
    const svc = fakeService({
      frontendEntry: async (id, workspaceId) => {
        seen = { id, workspaceId };
        return { ok: true, code: "x", bust: "1" };
      },
    });
    await appWith(svc).request("/plugins/with-fe/frontend?workspace=team-a");
    expect(seen).toEqual({ id: "with-fe", workspaceId: "team-a" });
  });

  it("unversioned requests revalidate (no-cache)", async () => {
    const svc = fakeService({
      frontendEntry: async () => ({ ok: true, code: "x", bust: "1" }),
    });
    const res = await appWith(svc).request("/plugins/with-fe/frontend?workspace=w");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("maps every block reason to a bare 404 (no reason leakage)", async () => {
    for (const reason of [
      "not-found",
      "not-loaded",
      "no-frontend",
      "workspace-disabled",
      "entry-escapes",
    ]) {
      const svc = fakeService({ frontendEntry: async () => ({ ok: false, reason }) });
      const res = await appWith(svc).request(`/plugins/p/frontend?workspace=w`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string; reason?: string };
      expect(body.error).toBeDefined();
      expect(body.reason).toBeUndefined();
    }
  });

  it("absent workspace query still reaches the service (undefined → default-workspace resolution)", async () => {
    let seen: { workspaceId?: string } | undefined;
    const svc = fakeService({
      frontendEntry: async (_id, workspaceId) => {
        seen = { workspaceId };
        return { ok: true, code: "x", bust: "1" };
      },
    });
    await appWith(svc).request("/plugins/p/frontend");
    expect(seen).toEqual({ workspaceId: undefined });
  });

  it("503 when the manager service is absent", async () => {
    const res = await appWith().request("/plugins/p/frontend");
    expect(res.status).toBe(503);
  });

  it("500 when the service throws", async () => {
    const svc = fakeService({
      frontendEntry: async () => {
        throw new Error("disk gone");
      },
    });
    const res = await appWith(svc).request("/plugins/p/frontend?workspace=w");
    expect(res.status).toBe(500);
  });
});

// ─── GET /plugins — the additive frontend field (plan 03) ───────────────────

describe("GET /plugins — additive frontend field", () => {
  it("passes loaded rows with their frontend field through untouched", async () => {
    const listWithFe: PluginListResponse = {
      loaded: [
        {
          id: "with-fe",
          name: "With FE",
          version: "1.0.0",
          tier: "standard",
          trust: "local",
          locked: false,
          dependsOn: [],
          frontend: { apiVersion: "^1", entry: "frontend.js", bust: "1727100000000" },
        },
        ...fakeList.loaded,
      ],
      disabledWithReason: [],
      discovered: [],
      missing: [],
    };
    const res = await appWith(fakeService({ list: async () => listWithFe })).request("/plugins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginListResponse;
    const row = body.loaded.find((r) => r.id === "with-fe");
    expect(row?.frontend).toEqual({
      apiVersion: "^1",
      entry: "frontend.js",
      bust: "1727100000000",
    });
    // Additive: rows without the field are unchanged.
    expect(body.loaded.find((r) => r.id === "tool-fs")?.frontend).toBeUndefined();
  });
});
