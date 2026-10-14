/**
 * account-usage extension — polls Claude + Codex subscription usage via the
 * `claude-oauth` / `codex-oauth` auth providers (registered by the external
 * claude/codex extensions) and provides `accountUsageServiceHandle`.
 *
 * Auth providers are looked up PER FETCH (`host.getAuthProvider`), so a
 * provider loaded after this extension, or absent entirely, is handled
 * (absent ⇒ `not-configured`). No secrets are stored or logged.
 */
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createClaudeFetcher, createCodexFetcher, type FetcherDeps } from "./fetchers.js";
import { accountUsageServiceHandle, createAccountUsageService } from "./service.js";

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

let disposeService: (() => void) | undefined;

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
    },
    now: () => Date.now(),
    random: Math.random,
    logger,
  });
  disposeService = host.provideService(accountUsageServiceHandle, service);
  logger.info("account-usage: service activated");
}

export function deactivate(): void {
  disposeService?.();
  disposeService = undefined;
}

export const extension: Extension = { manifest, activate, deactivate };
