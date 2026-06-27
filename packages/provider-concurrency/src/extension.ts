import type { Extension, HostAPI, Logger, Manifest, StorageNamespace } from "@dispatch/kernel";
import type { ConcurrencyManagerOpts, ConcurrencyService } from "./concurrency-manager.js";
import { createConcurrencyManager } from "./concurrency-manager.js";
import { concurrencyServiceHandle } from "./service.js";

export const manifest: Manifest = {
  id: "provider-concurrency",
  name: "Provider Concurrency Limits",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  capabilities: { db: true },
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

/**
 * Wrap a `ConcurrencyService` so `setLimit`/`removeLimit` persist to the
 * given `StorageNamespace`. All other methods delegate directly to the inner
 * service. Persistence is fire-and-forget — a storage write failure logs a
 * warning but does NOT fail the API call (the in-memory limit is already set).
 */
function createPersistedService(
  inner: ConcurrencyService,
  storage: StorageNamespace,
  logger: Logger,
): ConcurrencyService {
  return {
    acquire: inner.acquire.bind(inner),
    reportRateLimit: inner.reportRateLimit.bind(inner),
    setLimit(providerId, limit) {
      inner.setLimit(providerId, limit);
      storage.set(providerId, String(limit)).catch((err) =>
        logger.warn("provider-concurrency: failed to persist limit", {
          providerId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    },
    removeLimit(providerId) {
      inner.removeLimit(providerId);
      storage.delete(providerId).catch((err) =>
        logger.warn("provider-concurrency: failed to delete persisted limit", {
          providerId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    },
    getLimit: inner.getLimit.bind(inner),
    getLimits: inner.getLimits.bind(inner),
    getStatus: inner.getStatus.bind(inner),
    getStatusAll: inner.getStatusAll.bind(inner),
    destroy: inner.destroy.bind(inner),
  };
}

/**
 * Load saved limits from storage and apply them to the manager.
 * Called during activate, before the service is registered.
 */
async function loadLimits(
  storage: StorageNamespace,
  manager: ConcurrencyService,
  logger: Logger,
): Promise<void> {
  const keys = await storage.keys();
  for (const providerId of keys) {
    const raw = await storage.get(providerId);
    if (raw === null) continue;
    const limit = Number.parseInt(raw, 10);
    if (!Number.isNaN(limit) && limit > 0) {
      manager.setLimit(providerId, limit);
      logger.info(`provider-concurrency: restored limit ${limit} for "${providerId}"`);
    }
  }
}

export async function activate(host: HostAPI): Promise<void> {
  const logger = host.logger;
  const storage = host.storage("provider-concurrency");

  const managerOpts: ConcurrencyManagerOpts = {
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
  };

  const inner = createConcurrencyManager(managerOpts);

  // Restore persisted limits before registering the service so the first
  // request sees the correct configuration.
  await loadLimits(storage, inner, logger);

  const service = createPersistedService(inner, storage, logger);
  host.provideService(concurrencyServiceHandle, service);
  logger.info("provider-concurrency: registered");
}

export const extension: Extension = {
  manifest,
  activate,
};
