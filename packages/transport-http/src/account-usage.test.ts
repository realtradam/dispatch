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
      opencode: async () => ({
        ok: true,
        usage: {
          account: { accountId: null, email: null, planType: null },
          limits: [],
          limitReached: false,
          canServe: true,
          creditOverage: false,
          credits: null,
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
  it("returns every provider in fixed order with no secrets", async () => {
    const res = await app(true).request("/usage");
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as AccountUsageResponse;
    expect(body.servedAt).toBe(1000);
    expect(body.providers.map((p) => [p.provider, p.state])).toEqual([
      ["claude", "fresh"],
      ["codex", "not-configured"],
      ["opencode", "fresh"],
    ]);
    expect(Object.keys(body.providers[0] ?? {}).sort()).toEqual(
      [
        "account",
        "canServe",
        "creditOverage",
        "credits",
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
    const opencode = await a.request("/usage/opencode");
    expect(opencode.status).toBe(200);
    expect(((await opencode.json()) as AccountUsageReport).label).toBe("OpenCode");
    expect((await a.request("/usage/gemini")).status).toBe(404);
    // Hyper is no longer a reported account.
    expect((await a.request("/usage/hyper")).status).toBe(404);
  });

  it("no longer exposes per-provider usage settings", async () => {
    const res = await app(true).request("/usage/opencode/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyAllowance: 200 }),
    });
    expect(res.status).toBe(404);
  });

  it("503s when the service is absent", async () => {
    expect((await app(false).request("/usage")).status).toBe(503);
  });
});
