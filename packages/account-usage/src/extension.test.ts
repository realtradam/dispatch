/**
 * Integration: the REAL kernel host + the REAL account-usage extension + a
 * stand-in provider extension that emits `providerResponseHeaders` exactly as
 * the external claude/codex providers do. Fakes only the outermost edge
 * (global fetch → the usage endpoints).
 */
import {
  type BearerTokenCredentials,
  createBus,
  createHost,
  createLogger,
  type Extension,
  type HostAPI,
  providerResponseHeaders,
} from "@dispatch/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extension as accountUsageExt } from "./extension.js";
import { accountUsageServiceHandle } from "./service.js";

const sink = { emit: () => {} };
const logger = createLogger({ extensionId: "t" }, sink, { now: () => 0, newId: () => "t" });

function hostDeps() {
  return {
    logger,
    config: { get: () => undefined, getAll: () => ({}) },
    storageFactory: () => ({
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      has: async () => false,
      keys: async () => [],
    }),
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    permissions: { check: async () => ({ allowed: true }) },
    scheduler: { register: () => {}, unregister: () => {} },
    bus: createBus(logger),
    events: { emit: () => {} },
    logSink: sink,
    logDeps: { now: () => 0, newId: () => "t" },
  };
}

/** Stand-in for auth-claude + provider-anthropic: an auth and a header emitter. */
function fakeClaude(captured: { host?: HostAPI }): Extension {
  return {
    manifest: {
      id: "fake-claude",
      name: "fake",
      version: "0.0.0",
      apiVersion: "^0.1.0",
      tier: "standard",
      trust: "local",
    },
    activate(host) {
      captured.host = host;
      host.defineAuth({
        id: "claude-oauth",
        resolve: async (): Promise<BearerTokenCredentials> => ({
          type: "bearer-token",
          token: "tok",
        }),
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account-usage extension ⇄ providerResponseHeaders", () => {
  it("an emitted Claude response updates the cached 5h window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/usage")) {
          return new Response(
            JSON.stringify({
              five_hour: { utilization: 10 },
              seven_day: { utilization: 5 },
              account_id: "acct",
              email: "e@x",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const captured: { host?: HostAPI } = {};
    const host = createHost([fakeClaude(captured), accountUsageExt], hostDeps());
    await host.activate();
    const svc = captured.host?.getService(accountUsageServiceHandle);
    if (!svc) throw new Error("account-usage service not provided");

    const before = await svc.get("claude");
    expect(before.state).toBe("fresh");
    expect(before.limits.find((l) => l.id === "claude:5h")?.used).toBe(10);

    captured.host?.emit(providerResponseHeaders, {
      providerId: "anthropic",
      authId: "claude-oauth",
      status: 200,
      headers: { "anthropic-ratelimit-unified-5h-utilization": "0.37" },
    });

    const after = await svc.get("claude");
    expect(after.limits.find((l) => l.id === "claude:5h")?.used).toBe(37);
    expect(after.limits.find((l) => l.id === "claude:7d")?.used).toBe(5);
    expect(after.fetchedAt).toBe(before.fetchedAt);
    await host.deactivate();
  });
});
