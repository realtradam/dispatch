import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { type ConcurrencyService, createConcurrencyManager } from "./concurrency-manager.js";
import { concurrencyServiceHandle } from "./service.js";

export const manifest: Manifest = {
  id: "provider-concurrency",
  name: "Provider Concurrency Limits",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  contributes: { services: ["provider-concurrency/service"] },
};

/**
 * Default tuning constants.
 *
 * - `SLOT_TIMEOUT_MS` (5 min): a slot held longer than this is force-reclaimed
 *   by the watchdog (deadlock / stuck-agent recovery). Generation streams
 *   rarely exceed 2–3 minutes; 5 min is a generous safety margin.
 * - `WATCHDOG_INTERVAL_MS` (30s): how often the watchdog sweeps for stale slots.
 * - `DEFAULT_PAUSE_MS` (30s): default 429 backoff when no Retry-After is given.
 *   Umans docs note each concurrency 429 deprioritizes the account for ~30 min,
 *   but a 30s queue pause prevents immediate re-overshoot while still allowing
 *   recovery.
 * - `RELEASE_COOLDOWN_MS` (200ms): after a slot is released, hold it for this
 *   duration before recycling it to the next waiter. Covers the upstream
 *   provider's accounting lag — the provider's concurrent_sessions counter
 *   may not decrement the instant our stream completes, so re-admitting
 *   immediately risks an N+1 overshoot that triggers a 429. 200ms is the
 *   default most concurrency proxies use for AI/LLM APIs.
 */
const SLOT_TIMEOUT_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;
const DEFAULT_PAUSE_MS = 30 * 1000;
const RELEASE_COOLDOWN_MS = 200;

export function activate(host: HostAPI): void {
  const logger = host.logger;

  const manager: ConcurrencyService = createConcurrencyManager({
    now: () => Date.now(),
    slotTimeoutMs: SLOT_TIMEOUT_MS,
    watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
    defaultPauseMs: DEFAULT_PAUSE_MS,
    releaseCooldownMs: RELEASE_COOLDOWN_MS,
    onWatchdogReclaim: (providerId, conversationId, heldMs) => {
      logger.warn("provider-concurrency: watchdog reclaimed stale slot", {
        providerId,
        conversationId,
        heldMs,
      });
    },
    onPause: (providerId, durationMs) => {
      logger.warn("provider-concurrency: 429 backoff — pausing queue", {
        providerId,
        durationMs,
      });
    },
  });

  host.provideService(concurrencyServiceHandle, manager);
  logger.info("provider-concurrency: registered");
}

export const extension: Extension = {
  manifest,
  activate,
};
