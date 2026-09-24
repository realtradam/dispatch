import type { SearchConfigService } from "@dispatch/tool-web-search";
import type {
  SearchBackendConfigResponse,
  UpdateSearchConfigRequest,
} from "@dispatch/transport-contract";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { ConversationStore } from "./seam.js";

/**
 * Route tests for the GLOBAL search-backend selection (`GET/PUT
 * /search/config`) — mirrors the heartbeat route tests: thin-shell mapping
 * (parse → delegate → status), plus the graceful degrade when the
 * `tool-web-search` extension is not loaded.
 */

function createFakeStore(): ConversationStore {
  return {} as unknown as ConversationStore;
}

function createFakeOrchestrator(): unknown {
  return { streamTurn: vi.fn() };
}

function createFakeCredentialStore(): unknown {
  return {};
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  span: () => ({ end: () => {} }),
  child: () => noopLogger,
};

const OK_AVAILABLE = [
  { id: "firecrawl", label: "Firecrawl (self-hosted)", configured: true },
  { id: "umans", label: "Umans (Exa)", configured: true },
];

function createFakeSearchConfigService(backend = "firecrawl"): SearchConfigService {
  return {
    getConfig: async () => ({ backend, available: OK_AVAILABLE }),
    updateConfig: async (update: UpdateSearchConfigRequest) => {
      if (update.backend === "umans") return { ok: true, config: { backend: "umans" } };
      if (update.backend === "none") return { ok: true, config: { backend: "none" } };
      if (update.backend === "native") return { ok: false, error: "unknown-backend" as const };
      return { ok: false, error: "not-configured" as const };
    },
    availableBackends: () => OK_AVAILABLE,
    resolveBackend: async () => null,
  };
}

function createAppWith(service?: SearchConfigService) {
  return createApp({
    conversationStore: createFakeStore(),
    orchestrator: createFakeOrchestrator() as never,
    credentialStore: createFakeCredentialStore() as never,
    searchConfigService: service,
    logger: noopLogger,
  });
}

describe("GET /search/config", () => {
  it("returns the defaults when no service is wired (graceful degrade)", async () => {
    const app = createAppWith();
    const res = await app.request("/search/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBackendConfigResponse;
    expect(body.backend).toBe("firecrawl");
    expect(body.available).toEqual([
      { id: "firecrawl", label: "Firecrawl (self-hosted)", configured: true },
    ]);
  });

  it("delegates to the service (selection + availability)", async () => {
    const app = createAppWith(createFakeSearchConfigService("umans"));
    const res = await app.request("/search/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBackendConfigResponse;
    expect(body.backend).toBe("umans");
    expect(body.available).toEqual(OK_AVAILABLE);
  });
});

describe("PUT /search/config", () => {
  it("applies a valid backend and echoes the new config", async () => {
    const app = createAppWith(createFakeSearchConfigService());
    const res = await app.request("/search/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "umans" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBackendConfigResponse;
    expect(body.backend).toBe("umans");
    expect(body.available).toEqual(OK_AVAILABLE);
  });

  it("accepts the 'none' off state", async () => {
    const app = createAppWith(createFakeSearchConfigService());
    const res = await app.request("/search/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "none" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBackendConfigResponse;
    expect(body.backend).toBe("none");
  });

  it("maps an unknown backend to 400", async () => {
    const app = createAppWith(createFakeSearchConfigService());
    const res = await app.request("/search/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "native" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("native");
  });

  it("maps an unconfigured backend to 400", async () => {
    const app = createAppWith(createFakeSearchConfigService());
    const res = await app.request("/search/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "unavailable-id" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not configured");
  });

  it("rejects a non-string / missing backend with 400 (service untouched)", async () => {
    const service = createFakeSearchConfigService();
    const spy = vi.spyOn(service, "updateConfig");
    const app = createAppWith(service);
    const res = await app.request("/search/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 503 when the service is not wired (extension not loaded)", async () => {
    const app = createAppWith();
    const res = await app.request("/search/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "umans" }),
    });
    expect(res.status).toBe(503);
  });
});
