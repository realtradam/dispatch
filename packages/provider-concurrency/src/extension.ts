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
 *   recovery. Combined with adaptive headroom (limit reduced by 1) + the usage
 *   gate, the resumed queue no longer re-overshoots — so the pause is kept
 *   (gives upstream a breather) rather than dropped.
 * - `RELEASE_COOLDOWN_MS` (350ms): after a slot is released, hold it for this
 *   duration before recycling it to the next waiter. Covers the upstream
 *   provider's accounting lag — the provider's concurrent_sessions counter may
 *   not decrement the instant our stream completes, so re-admitting immediately
 *   risks an N+1 overshoot that triggers a 429. Raised from 200ms to 350ms
 *   (Umans's accounting lag exceeded the 200ms cooldown, causing overshoot at 4
 *   connections). Configurable + persisted per provider (PUT
 *   /concurrency/cooldown/:providerId).
 */
const SLOT_TIMEOUT_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;
const DEFAULT_PAUSE_MS = 30 * 1000;
const RELEASE_COOLDOWN_MS = 350;

/**
 * Storage key prefixes. Limits are stored under the bare `<providerId>` key
 * (unchanged for backward compatibility). Cooldowns + the adaptive-headroom
 * auto-reduce marker are stored under their own prefixed keys so they persist
 * independently without loadLimits misreading them as limits.
 */
const COOLDOWN_KEY_PREFIX = "cooldown:";
const AUTOREDUCE_KEY_PREFIX = "auto-reduce:";

/**
 * Wrap a `ConcurrencyService` so `setLimit`/`removeLimit`/`setCooldown` persist
 * to the given `StorageNamespace`. All other methods delegate directly to the
 * inner service. Persistence is fire-and-forget — a storage write failure logs
 * a warning but does NOT fail the API call (the in-memory value is already set).
 *
 * `restoreLimit` is NOT persisted here — it is a startup restore FROM disk, so
 * it delegates straight through (the value is already on disk).
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
      // A MANUAL limit set clears the auto-reduce notice (the user took
      // control) → drop the persisted auto-reduce marker too.
      storage.delete(`${AUTOREDUCE_KEY_PREFIX}${providerId}`).catch(() => {
        /* absent marker is fine */
      });
    },
    restoreLimit: inner.restoreLimit.bind(inner),
    removeLimit(providerId) {
      inner.removeLimit(providerId);
      storage.delete(providerId).catch((err) =>
        logger.warn("provider-concurrency: failed to delete persisted limit", {
          providerId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      storage.delete(`${AUTOREDUCE_KEY_PREFIX}${providerId}`).catch(() => {
        /* absent marker is fine */
      });
    },
    setCooldown(providerId, cooldownMs) {
      inner.setCooldown(providerId, cooldownMs);
      storage.set(`${COOLDOWN_KEY_PREFIX}${providerId}`, String(cooldownMs)).catch((err) =>
        logger.warn("provider-concurrency: failed to persist cooldown", {
          providerId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    },
    getLimit: inner.getLimit.bind(inner),
    getLimits: inner.getLimits.bind(inner),
    getCooldown: inner.getCooldown.bind(inner),
    getCooldowns: inner.getCooldowns.bind(inner),
    getStatus: inner.getStatus.bind(inner),
    getStatusAll: inner.getStatusAll.bind(inner),
    destroy: inner.destroy.bind(inner),
  };
}

/**
 * Load saved limits from storage and apply them to the manager via
 * `restoreLimit` (NOT `setLimit` — Bug 3). `setLimit` is a MANUAL user action
 * that clears the auto-reduce notice; using it at startup would wipe the
 * persisted auto-reduce banner. `restoreLimit` seeds the limit WITHOUT clearing
 * the notice, and `loadAutoReduce` re-applies the notice afterward.
 *
 * Skips prefixed keys (cooldown:/auto-reduce:) — those are loaded by their
 * own loaders.
 */
async function loadLimits(
  storage: StorageNamespace,
  manager: ConcurrencyService,
  logger: Logger,
): Promise<void> {
  const keys = await storage.keys();
  for (const key of keys) {
    if (key.startsWith(COOLDOWN_KEY_PREFIX)) continue; // cooldown settings
    if (key.startsWith(AUTOREDUCE_KEY_PREFIX)) continue; // auto-reduce markers
    const providerId = key;
    const raw = await storage.get(providerId);
    if (raw === null) continue;
    const limit = Number.parseInt(raw, 10);
    if (!Number.isNaN(limit) && limit > 0) {
      manager.restoreLimit(providerId, limit);
      logger.info(`provider-concurrency: restored limit ${limit} for "${providerId}"`);
    }
  }
}

/**
 * Load saved auto-reduce markers and re-apply them via `restoreLimit` so the
 * frontend banner survives a restart (Bug 3). A marker is stored under
 * `auto-reduce:<providerId>` with the value = the ORIGINAL limit before
 * reduction (autoReducedFrom). The current (reduced) limit was already restored
 * by {@link loadLimits}; this call re-marks it as auto-reduced.
 */
async function loadAutoReduce(
  storage: StorageNamespace,
  manager: ConcurrencyService,
  logger: Logger,
): Promise<void> {
  const keys = await storage.keys(AUTOREDUCE_KEY_PREFIX);
  for (const key of keys) {
    const providerId = key.slice(AUTOREDUCE_KEY_PREFIX.length);
    if (providerId.length === 0) continue;
    const raw = await storage.get(key);
    if (raw === null) continue;
    const autoReducedFrom = Number.parseInt(raw, 10);
    if (!Number.isNaN(autoReducedFrom) && autoReducedFrom > 0) {
      const currentLimit = manager.getLimit(providerId);
      if (currentLimit !== undefined && currentLimit < autoReducedFrom) {
        manager.restoreLimit(providerId, currentLimit, autoReducedFrom);
        logger.info(
          `provider-concurrency: restored auto-reduce notice for "${providerId}" ` +
            `(${autoReducedFrom} -> ${currentLimit})`,
        );
      }
    }
  }
}

/**
 * Load saved cooldowns from storage and apply them to the manager.
 * Cooldowns are stored under `cooldown:<providerId>` keys (distinct from the
 * bare-`<providerId>` limit keys) so the two settings persist independently.
 */
async function loadCooldowns(
  storage: StorageNamespace,
  manager: ConcurrencyService,
  logger: Logger,
): Promise<void> {
  const keys = await storage.keys(COOLDOWN_KEY_PREFIX);
  for (const key of keys) {
    const providerId = key.slice(COOLDOWN_KEY_PREFIX.length);
    if (providerId.length === 0) continue;
    const raw = await storage.get(key);
    if (raw === null) continue;
    const cooldownMs = Number.parseInt(raw, 10);
    if (!Number.isNaN(cooldownMs) && cooldownMs >= 0) {
      manager.setCooldown(providerId, cooldownMs);
      logger.info(`provider-concurrency: restored cooldown ${cooldownMs}ms for "${providerId}"`);
    }
  }
}

export async function activate(host: HostAPI): Promise<void> {
  const logger = host.logger;
  const storage = host.storage("provider-concurrency");

  // Build the injected usage-poll effect from the host's provider registry.
  // Lazy (called at poll time, not activate time) so activation order with the
  // provider extensions doesn't matter. A provider that doesn't expose
  // `getUsage` (or isn't registered) → returns undefined → the manager's usage
  // gate falls back to cooldown-only recycling for that provider. This keeps
  // the manager pure (the HTTP poll is an injected effect, not hardcoded fetch).
  const fetchUsage = async (providerId: string) => {
    const provider = host.getProviders().get(providerId);
    if (provider === undefined || provider.getUsage === undefined) return undefined;
    return provider.getUsage();
  };

  const managerOpts: ConcurrencyManagerOpts = {
    now: () => Date.now(),
    slotTimeoutMs: SLOT_TIMEOUT_MS,
    watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
    defaultPauseMs: DEFAULT_PAUSE_MS,
    releaseCooldownMs: RELEASE_COOLDOWN_MS,
    fetchUsage,
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
    onLimitReduced: (providerId, newLimit, oldLimit) => {
      logger.warn("provider-concurrency: 429 adaptive headroom — limit reduced", {
        providerId,
        oldLimit,
        newLimit,
      });
      // Persist the reduced (one-way) limit so it survives a restart, AND the
      // auto-reduce marker (autoReducedFrom) so the banner survives too (Bug 3).
      storage.set(providerId, String(newLimit)).catch((err) =>
        logger.warn("provider-concurrency: failed to persist auto-reduced limit", {
          providerId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      storage.set(`${AUTOREDUCE_KEY_PREFIX}${providerId}`, String(oldLimit)).catch((err) =>
        logger.warn("provider-concurrency: failed to persist auto-reduce marker", {
          providerId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    },
    onUsagePollError: (providerId, err) => {
      // A throwing getUsage() is treated as "no usage info" (cooldown-only
      // fallback) by the manager — this is WARN-level observability only (Bug 2).
      logger.warn("provider-concurrency: usage poll failed — falling back to cooldown-only", {
        providerId,
        err: err instanceof Error ? err.message : String(err),
      });
    },
  };

  const inner = createConcurrencyManager(managerOpts);

  // Restore persisted limits + auto-reduce notices + cooldowns before registering
  // the service so the first request sees the correct configuration.
  await loadLimits(storage, inner, logger);
  await loadAutoReduce(storage, inner, logger);
  await loadCooldowns(storage, inner, logger);

  const service = createPersistedService(inner, storage, logger);
  host.provideService(concurrencyServiceHandle, service);
  logger.info("provider-concurrency: registered");
}

export const extension: Extension = {
  manifest,
  activate,
};
