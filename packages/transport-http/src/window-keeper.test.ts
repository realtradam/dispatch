import type { Logger } from "@dispatch/kernel";
import type {
  WindowKeeperConfigResponse,
  WindowKeeperProviderSetting,
} from "@dispatch/transport-contract";
import type { WindowKeeperService } from "@dispatch/window-keeper";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { ConversationStore } from "./seam.js";

/**
 * Route tests for the per-provider usage-window keeper toggles
 * (`GET/PUT /window-keeper`) — thin-shell mapping (parse → delegate → status)
 * plus the graceful 503 when the `window-keeper` extension is not loaded.
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
} as unknown as Logger;

const DEFAULT_PROVIDERS: readonly WindowKeeperProviderSetting[] = [
  { id: "claude", label: "Claude", enabled: true },
  { id: "codex", label: "Codex", enabled: true },
];

function config(
  overrides: Partial<Record<"claude" | "codex", boolean>> = {},
): WindowKeeperConfigResponse {
  return {
    providers: DEFAULT_PROVIDERS.map((provider) => ({
      ...provider,
      enabled: overrides[provider.id] ?? provider.enabled,
    })),
  };
}

function createFakeService(): WindowKeeperService {
  return {
    getConfig: async () => config(),
    setEnabled: async (update) => {
      if (update.provider !== "claude" && update.provider !== "codex") {
        return { ok: false, error: "invalid-provider" as const };
      }
      if (typeof update.enabled !== "boolean") {
        return { ok: false, error: "invalid-enabled" as const };
      }
      return {
        ok: true,
        config: config({ [update.provider]: update.enabled }),
      };
    },
  };
}

function createAppWith(service?: WindowKeeperService) {
  return createApp({
    conversationStore: createFakeStore(),
    orchestrator: createFakeOrchestrator() as never,
    credentialStore: createFakeCredentialStore() as never,
    windowKeeperService: service,
    logger: noopLogger,
  });
}

describe("GET /window-keeper", () => {
  it("returns 503 when the service is not wired (extension not loaded)", async () => {
    const app = createAppWith();
    const res = await app.request("/window-keeper");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Window keeper service not available" });
  });

  it("delegates to the service and returns the config", async () => {
    const app = createAppWith(createFakeService());
    const res = await app.request("/window-keeper");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: DEFAULT_PROVIDERS });
  });

  it("maps a throw to 500", async () => {
    const service: WindowKeeperService = {
      ...createFakeService(),
      getConfig: async () => {
        throw new Error("boom");
      },
    };
    const app = createAppWith(service);
    const res = await app.request("/window-keeper");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to read window keeper config" });
  });
});

describe("PUT /window-keeper", () => {
  it("returns 503 when the service is not wired (extension not loaded)", async () => {
    const app = createAppWith();
    const res = await app.request("/window-keeper", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude", enabled: false }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Window keeper service not available" });
  });

  it("applies a valid update and echoes the new config", async () => {
    const app = createAppWith(createFakeService());
    const res = await app.request("/window-keeper", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude", enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      providers: [
        { id: "claude", label: "Claude", enabled: false },
        { id: "codex", label: "Codex", enabled: true },
      ],
    });
  });

  it("maps a non-JSON body to 400", async () => {
    const app = createAppWith(createFakeService());
    const res = await app.request("/window-keeper", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("maps an invalid provider to 400", async () => {
    const app = createAppWith(createFakeService());
    const res = await app.request("/window-keeper", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "nope", enabled: false }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Invalid body: expected { provider: "claude" | "codex", enabled: boolean }',
    });
  });

  it("maps a non-boolean enabled to 400", async () => {
    const app = createAppWith(createFakeService());
    const res = await app.request("/window-keeper", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude", enabled: "yes" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Invalid body: expected { provider: "claude" | "codex", enabled: boolean }',
    });
  });

  it("passes undefined for both fields when the body is not an object", async () => {
    const service = createFakeService();
    const spy = vi.spyOn(service, "setEnabled");
    const app = createAppWith(service);
    const res = await app.request("/window-keeper", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("nope"),
    });
    expect(res.status).toBe(400);
    expect(spy).toHaveBeenCalledWith({ provider: undefined, enabled: undefined });
  });

  it("maps a throw to 500", async () => {
    const service: WindowKeeperService = {
      ...createFakeService(),
      setEnabled: async () => {
        throw new Error("boom");
      },
    };
    const app = createAppWith(service);
    const res = await app.request("/window-keeper", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude", enabled: false }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to update window keeper config" });
  });
});
