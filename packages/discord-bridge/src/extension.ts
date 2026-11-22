/**
 * @dispatch/discord-bridge — relays Discord chat threads (via the Felicity
 * bot's agent API) with EXISTING Dispatch conversations, both ways.
 *
 * Config: `FELICITY_API_URL` + `FELICITY_API_TOKEN` through `host.secrets`.
 * Either missing → the plugin stays inert and logs why. The bridge always
 * connects out (long-poll); Felicity never calls Dispatch.
 */

import { conversationDeleted, conversationStoreHandle } from "@dispatch/conversation-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { conversationClosed, sessionOrchestratorHandle } from "@dispatch/session-orchestrator";
import { Bridge, type BridgeDeps } from "./bridge.js";
import { createRestClient, type FelicityClient } from "./client.js";
import type { Clock } from "./sender.js";

export const manifest: Manifest = {
  id: "discord-bridge",
  name: "Discord Bridge",
  version: "0.1.0",
  apiVersion: "^0.1.0",
  tier: "standard",
  trust: "bundled",
  // enqueue / stopTurn / subscribe + the conversationClosed hook; history
  // replay + conversation lookup + the conversationDeleted hook.
  dependsOn: ["session-orchestrator", "conversation-store"],
  activation: "eager",
  capabilities: { network: true, secrets: true },
};

/** The two secrets the bridge reads (also used by the global `discord` skill). */
export const FELICITY_API_URL = "FELICITY_API_URL";
export const FELICITY_API_TOKEN = "FELICITY_API_TOKEN";

export interface BridgeConfig {
  readonly apiUrl: string;
  readonly token: string;
}

/** Read the config from `host.secrets`; null (with the reason) when incomplete. */
export async function readConfig(
  host: Pick<HostAPI, "secrets">,
): Promise<{ config: BridgeConfig } | { missing: string[] }> {
  const [apiUrl, token] = await Promise.all([
    host.secrets.get(FELICITY_API_URL),
    host.secrets.get(FELICITY_API_TOKEN),
  ]);
  const missing: string[] = [];
  if (apiUrl === null || apiUrl.trim() === "") missing.push(FELICITY_API_URL);
  if (token === null || token.trim() === "") missing.push(FELICITY_API_TOKEN);
  if (missing.length > 0 || apiUrl === null || token === null) return { missing };
  return { config: { apiUrl: apiUrl.trim(), token: token.trim() } };
}

/** Real time: `Date.now` + an abortable `setTimeout` sleep. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener("abort", done, { once: true });
    }),
};

export interface DiscordBridgeOptions {
  /** The outer network edge (defaults to global `fetch`). */
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  /** Build the Felicity client (defaults to the REST client over `fetch`). */
  readonly createClient?: (config: BridgeConfig) => FelicityClient;
  /** Override config resolution (defaults to `host.secrets`). */
  readonly resolveConfig?: (
    host: HostAPI,
  ) => Promise<{ config: BridgeConfig } | { missing: string[] }>;
  readonly relaySender?: BridgeDeps["relaySender"];
}

/** Build the extension. State lives in this closure (fresh per activation). */
export function createDiscordBridgeExtension(opts: DiscordBridgeOptions = {}): Extension {
  let bridge: Bridge | undefined;
  let disposers: (() => void)[] = [];
  let idCounter = 0;

  return {
    manifest,
    async activate(host) {
      const resolved = await (opts.resolveConfig ?? readConfig)(host);
      if ("missing" in resolved) {
        host.logger.info("discord-bridge inert: missing configuration", {
          missing: resolved.missing.join(","),
        });
        return;
      }
      const { config } = resolved;
      const client =
        opts.createClient?.(config) ??
        createRestClient({
          baseUrl: config.apiUrl,
          token: config.token,
          fetch: opts.fetch ?? fetch,
        });
      const clock = opts.clock ?? systemClock;
      const b = new Bridge({
        client,
        orchestrator: host.getService(sessionOrchestratorHandle),
        store: host.getService(conversationStoreHandle),
        clock,
        logger: host.logger,
        newId: () => `${clock.now().toString(36)}${(idCounter++).toString(36)}`,
        ...(opts.relaySender !== undefined ? { relaySender: opts.relaySender } : {}),
      });
      bridge = b;
      disposers.push(
        host.on(conversationClosed, (p) => {
          void b.onConversationClosed(p.conversationId);
        }),
        host.on(conversationDeleted, (p) => {
          void b.onConversationDeleted(p.conversationId);
        }),
      );
      b.start();
      // The URL is not secret; the token is never logged.
      host.logger.info("discord-bridge active", { apiUrl: config.apiUrl });
    },
    async deactivate() {
      for (const dispose of disposers) dispose();
      disposers = [];
      const b = bridge;
      bridge = undefined;
      await b?.stop();
    },
  };
}

/** The bundled instance. */
export const extension: Extension = createDiscordBridgeExtension();
