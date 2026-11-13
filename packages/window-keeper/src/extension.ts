/**
 * window-keeper extension — the imperative shell.
 *
 * One keeper per provider profile (Claude, Codex). Each keeper is driven by
 * `providerResponseHeaders` (routed by auth id) and by the `account-usage`
 * service, and starts a window by sending ONE minimal inference request
 * through the provider. Two persisted toggles (one per provider) start/stop
 * the loops; they are exposed through `windowKeeperServiceHandle` for the
 * HTTP routes.
 */

import { accountUsageServiceHandle } from "@dispatch/account-usage";
import {
  type ChatMessage,
  type Extension,
  type HostAPI,
  type Manifest,
  providerResponseHeaders,
} from "@dispatch/kernel";
import { createWindowKeeper, type KickOutcome } from "./keeper.js";
import { KEEPER_PROFILES, type KeeperProfile } from "./profiles.js";
import {
  createWindowKeeperService,
  DEFAULT_WINDOW_KEEPER_SETTINGS,
  parseWindowKeeperSettings,
  WINDOW_KEEPER_SETTINGS_KEY,
  type WindowKeeperSettings,
  windowKeeperServiceHandle,
} from "./settings.js";

export const manifest: Manifest = {
  id: "window-keeper",
  name: "Usage Window Keeper",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "standard",
  trust: "bundled",
  activation: "eager",
  capabilities: {},
  contributes: { services: ["window-keeper/service"] },
};

/** The one user message every kick sends. */
const KICK_MESSAGE: ChatMessage = { role: "user", chunks: [{ type: "text", text: "hi" }] };

/** Abort a kick that has not finished in this long. */
const KICK_TIMEOUT_MS = 30_000;

let disposers: Array<() => void> = [];
/** True once deactivate ran; the detached settings load must then do nothing. */
let deactivated = false;

export function activate(host: HostAPI): void {
  const logger = host.logger.child({ attrs: { extensionId: "window-keeper" } });

  async function sendKick(profile: KeeperProfile): Promise<KickOutcome> {
    try {
      const provider = host.getProviders().get(profile.providerId);
      if (provider === undefined) return "unavailable";

      let model: string | undefined;
      if (provider.listModels === undefined) {
        model = undefined;
      } else {
        const ids = (await provider.listModels()).map((entry) => entry.id);
        if (ids.length === 0) return "unavailable";
        model = profile.pickModel(ids);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), KICK_TIMEOUT_MS);
      try {
        const events = provider.stream([KICK_MESSAGE], [], {
          ...profile.streamOptions,
          signal: controller.signal,
          ...(model ? { model } : {}),
        });
        let outcome: KickOutcome = "ok";
        for await (const event of events) {
          if (event.type === "error") outcome = "error";
        }
        return outcome;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return "error";
    }
  }

  const keepers = new Map(
    KEEPER_PROFILES.map((profile) => [
      profile.id,
      createWindowKeeper({
        provider: profile.id,
        limitId: profile.limitId,
        parseReset: profile.parseReset,
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        getReport: async () => {
          const service = host.tryGetService(accountUsageServiceHandle);
          if (service === undefined) return null;
          try {
            return await service.get(profile.id, { refresh: true });
          } catch {
            return null;
          }
        },
        kick: () => sendKick(profile),
        logger,
      }),
    ]),
  );

  function applySettings(settings: WindowKeeperSettings): void {
    for (const profile of KEEPER_PROFILES) {
      const keeper = keepers.get(profile.id);
      if (keeper === undefined) continue;
      if (settings[profile.id]) keeper.start();
      else keeper.stop();
    }
  }

  const storage = host.storage("window-keeper");
  const service = createWindowKeeperService({ storage, onSettings: applySettings });

  deactivated = false;
  disposers = [
    host.provideService(windowKeeperServiceHandle, service),
    host.on(providerResponseHeaders, (payload) => {
      const profile = KEEPER_PROFILES.find((candidate) => candidate.authId === payload.authId);
      if (profile === undefined) return;
      keepers.get(profile.id)?.onResponseHeaders(payload.headers);
    }),
    () => {
      for (const keeper of keepers.values()) keeper.stop();
    },
  ];

  // `activate` stays synchronous: the persisted toggles load detached. A read
  // failure falls back to the defaults (both providers on).
  void (async () => {
    try {
      const raw = await storage.get(WINDOW_KEEPER_SETTINGS_KEY);
      if (deactivated) return;
      applySettings(parseWindowKeeperSettings(raw));
    } catch (err) {
      if (deactivated) return;
      logger.warn("window-keeper: failed to load settings", {
        error: err instanceof Error ? err.message : String(err),
      });
      applySettings(DEFAULT_WINDOW_KEEPER_SETTINGS);
    }
  })();

  logger.info("window-keeper: activated");
}

export function deactivate(): void {
  deactivated = true;
  for (const dispose of disposers) dispose();
  disposers = [];
}

export const extension: Extension = { manifest, activate, deactivate };
