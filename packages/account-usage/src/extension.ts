/**
 * account-usage extension — polls Claude + Codex subscription usage via the
 * `claude-oauth` / `codex-oauth` auth providers (registered by the external
 * claude/codex extensions) and provides `accountUsageServiceHandle`.
 *
 * OpenCode (the Go subscription's 5-hour / weekly / monthly allowance) uses
 * `OPENCODE_API_KEY` / `DISPATCH_BASE_URL` — the same environment the OpenCode
 * provider (provider-openai-compat) is configured from.
 *
 * Auth providers are looked up PER FETCH (`host.getAuthProvider`), so a
 * provider loaded after this extension, or absent entirely, is handled
 * (absent ⇒ `not-configured`). No secrets are stored or logged.
 *
 * It also subscribes to the kernel `providerResponseHeaders` event so the
 * claude/codex providers' inference responses update the cached windows
 * between polls (throttled; see `AccountUsageService.ingestHeaders`).
 */
import {
  type Extension,
  type HostAPI,
  type Manifest,
  providerResponseHeaders,
} from "@dispatch/kernel";
import {
  createClaudeFetcher,
  createCodexFetcher,
  createOpenCodeFetcher,
  type FetcherDeps,
} from "./fetchers.js";
import {
  accountUsageServiceHandle,
  createAccountUsageService,
  providerForResponse,
} from "./service.js";

export const manifest: Manifest = {
  id: "account-usage",
  name: "Account Usage",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "standard",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { services: ["account-usage/service"] },
};

let disposers: Array<() => void> = [];

export function activate(host: HostAPI): void {
  const logger = host.logger.child({ attrs: { extensionId: "account-usage" } });
  const base = (authId: string): FetcherDeps => ({
    fetchFn: (input, init) => globalThis.fetch(input, init),
    resolveCredentials: async () => {
      const auth = host.getAuthProvider(authId);
      return auth ? auth.resolve() : null;
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logger,
  });
  const service = createAccountUsageService({
    fetchers: {
      claude: createClaudeFetcher(base("claude-oauth")),
      codex: createCodexFetcher(base("codex-oauth")),
      // OpenCode is API-key auth read from the same env as its provider.
      opencode: createOpenCodeFetcher({
        fetchFn: (input, init) => globalThis.fetch(input, init),
        resolveConfig: () => {
          const apiKey = process.env.OPENCODE_API_KEY;
          if (!apiKey) return null;
          const baseURL = process.env.DISPATCH_BASE_URL;
          return baseURL ? { apiKey, baseURL } : { apiKey };
        },
        logger,
      }),
    },
    now: () => Date.now(),
    random: Math.random,
    logger,
  });
  disposers = [
    host.provideService(accountUsageServiceHandle, service),
    // Passive ingestion: providers emit their inference response headers;
    // route Claude/Codex ones (by auth id) into the cache.
    host.on(providerResponseHeaders, (payload) => {
      const provider = providerForResponse(payload);
      if (provider) service.ingestHeaders(provider, payload.headers, payload.status);
    }),
  ];
  logger.info("account-usage: service activated");
}

export function deactivate(): void {
  for (const d of disposers) d();
  disposers = [];
}

export const extension: Extension = { manifest, activate, deactivate };
