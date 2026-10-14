/**
 * account-usage extension — polls Claude + Codex subscription usage via the
 * `claude-oauth` / `codex-oauth` auth providers (registered by the external
 * claude/codex extensions) and provides `accountUsageServiceHandle`.
 *
 * Hyper (daily Hypercredits) uses `HYPER_API_KEY` / `HYPER_BASE_URL` like
 * provider-hyper; its allowance + reset time are settings persisted in this
 * extension's storage namespace.
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
  createHyperFetcher,
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
  capabilities: { network: true, db: true },
  contributes: { services: ["account-usage/service"] },
};

let disposers: Array<() => void> = [];

/** Storage key for the Hyper daily-credit settings (allowance + reset anchors). */
const HYPER_SETTINGS_KEY = "hyper-settings";

export function activate(host: HostAPI): void {
  const storage = host.storage("account-usage");
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
      // Hyper is API-key auth read from the same env as provider-hyper.
      hyper: createHyperFetcher({
        fetchFn: (input, init) => globalThis.fetch(input, init),
        resolveConfig: () => {
          const apiKey = process.env.HYPER_API_KEY;
          if (!apiKey) return null;
          const baseURL = process.env.HYPER_BASE_URL;
          return baseURL ? { apiKey, baseURL } : { apiKey };
        },
        logger,
      }),
    },
    settingsStore: {
      load: () => storage.get(HYPER_SETTINGS_KEY),
      save: (raw) => storage.set(HYPER_SETTINGS_KEY, raw),
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
