import { createAccountUsageService } from "@dispatch/account-usage";
import type { Logger } from "@dispatch/kernel";
import type { AccountUsageReport, AccountUsageResponse } from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ConversationStore, CredentialStore, SessionOrchestrator } from "./seam.js";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
  span() {
    throw new Error("unused");
  },
};

function app(withService: boolean) {
  const svc = createAccountUsageService({
    fetchers: {
      claude: async () => ({
        ok: true,
        usage: {
          account: { accountId: "acct", email: "me@x", planType: null },
          limits: [],
          limitReached: null,
          canServe: null,
          creditOverage: false,
          credits: null,
        },
      }),
      codex: async () => ({
        ok: false,
        kind: "not-configured",
        error: "No Codex OAuth credentials",
      }),
      hyper: async () => ({
        ok: true,
        usage: {
          account: { accountId: null, email: null, planType: null },
          limits: [],
          limitReached: null,
          canServe: true,
          creditOverage: false,
          credits: null,
          dailyBalance: 100,
        },
      }),
    },
    now: () => 1000,
    random: () => 0.5,
    logger: noopLogger,
  });
  return createApp({
    conversationStore: {} as unknown as ConversationStore,
    orchestrator: {} as unknown as SessionOrchestrator,
    credentialStore: {} as unknown as CredentialStore,
    ...(withService ? { accountUsageService: svc } : {}),
  });
}

describe("GET /usage", () => {
  it("returns both providers in fixed order with no secrets", async () => {
    const res = await app(true).request("/usage");
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as AccountUsageResponse;
    expect(body.servedAt).toBe(1000);
    expect(body.providers.map((p) => [p.provider, p.state])).toEqual([
      ["claude", "fresh"],
      ["codex", "not-configured"],
      ["hyper", "fresh"],
    ]);
    expect(Object.keys(body.providers[0] ?? {}).sort()).toEqual(
      [
        "account",
        "canServe",
        "creditOverage",
        "credits",
        "dailyCredits",
        "error",
        "fetchedAt",
        "label",
        "lastAttemptAt",
        "limitReached",
        "limits",
        "nextRefreshAt",
        "provider",
        "state",
      ].sort(),
    );
    expect(text).not.toMatch(/token|Bearer|refresh_token/i);
  });

  it("serves a single provider and 404s unknown ones", async () => {
    const a = app(true);
    expect((await a.request("/usage/codex")).status).toBe(200);
    expect((await a.request("/usage/gemini")).status).toBe(404);
  });

  it("PUT /usage/hyper/settings validates and applies the allowance + reset anchor", async () => {
    const a = app(true);
    const put = (path: string, body: unknown) =>
      a.request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await put("/usage/hyper/settings", { dailyAllowance: -1 })).status).toBe(400);
    expect((await put("/usage/claude/settings", { dailyAllowance: 5 })).status).toBe(404);
    const res = await put("/usage/hyper/settings", { dailyAllowance: 200, resetAnchor: 500 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccountUsageReport;
    expect(body.dailyCredits).toEqual({
      balance: 100,
      allowance: 200,
      resetAnchor: 500,
      resetSource: "manual",
    });
    expect(body.limits[0]).toMatchObject({
      id: "hyper:daily",
      unit: "credits",
      used: 100,
      limit: 200,
      resetsAt: 500 + 86_400_000,
    });
  });

  it("503s when the service is absent", async () => {
    expect((await app(false).request("/usage")).status).toBe(503);
  });
});
