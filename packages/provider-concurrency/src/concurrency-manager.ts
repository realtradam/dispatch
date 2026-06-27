/**
 * In-memory per-provider concurrency limiter.
 *
 * Tracks and limits how many concurrent API requests (token-generating
 * requests) are in flight per provider. When the limit is reached, additional
 * requests queue and are granted slots based on oldest-agent-first priority
 * (the agent whose current prompt started the longest ago wins the next slot).
 *
 * A watchdog reclaims slots held beyond a timeout (deadlock / stuck-agent
 * recovery). 429 backoff pauses a provider's queue for a configurable duration.
 *
 * This module is the PURE decision logic. It takes an injected clock (`now`)
 * and injected timers (`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`)
 * so it is fully testable with deterministic fake time. The extension layer
 * wires real timers.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Status snapshot for a single provider's concurrency state. */
export interface ProviderConcurrencyStatus {
  readonly providerId: string;
  /** Configured concurrency limit. Always present (status is only returned for providers with a limit). */
  readonly limit: number;
  /** Currently in-flight (held) slots. */
  readonly inFlight: number;
  /** Agents waiting in the queue for a slot. */
  readonly queued: number;
  /** Whether the queue is paused (429 backoff). */
  readonly paused: boolean;
  /** When the pause expires (epoch-ms). Present only when paused. */
  readonly pausedUntil?: number;
}

/**
 * The limiter surface a consumer (session-orchestrator) needs: acquire a
 * slot before a provider stream starts, release it when the stream completes,
 * and report rate-limit (429) events so the manager can back off.
 */
export interface ConcurrencyLimiter {
  /**
   * Acquire a concurrency slot for `providerId`. Resolves immediately when a
   * slot is available; otherwise blocks (queued by oldest-agent-first) until
   * one frees up. The returned function MUST be called when the response
   * stream completes (in a `finally` block). For providers with no configured
   * limit, resolves instantly with a no-op release.
   *
   * If `onQueued` is provided and the request cannot be granted immediately
   * (at limit or paused), it is called synchronously BEFORE the Promise is
   * created. This lets the caller emit a "queued" status signal. If the slot
   * is granted immediately, `onQueued` is NOT called.
   *
   * @param providerId   The provider to limit (e.g. "umans", "openai-compat").
   * @param conversationId The agent requesting the slot.
   * @param promptStartedAt When the agent's current prompt (turn) started
   *                        (epoch-ms). Used for oldest-agent-first scheduling.
   * @param onQueued       Called synchronously when the request is enqueued
   *                       (not granted immediately). Optional.
   */
  acquire(
    providerId: string,
    conversationId: string,
    promptStartedAt: number,
    onQueued?: () => void,
  ): Promise<() => void>;

  /**
   * Report a 429 from a provider. Pauses the queue for that provider for
   * `retryAfterMs` (or a default duration when omitted). Queued and in-flight
   * requests are unaffected; new `acquire` calls block until the pause expires.
   */
  reportRateLimit(providerId: string, retryAfterMs?: number): void;
}

/**
 * The full service surface (limiter + config + status) for HTTP routes.
 */
export interface ConcurrencyService extends ConcurrencyLimiter {
  /** Set the concurrency limit for a provider. Creates the state if new. */
  setLimit(providerId: string, limit: number): void;
  /** Get the configured limit, or `undefined` when none. */
  getLimit(providerId: string): number | undefined;
  /** Remove the limit for a provider (makes it unlimited). */
  removeLimit(providerId: string): void;
  /** All configured limits as `{ providerId, limit }` entries. */
  getLimits(): readonly { providerId: string; limit: number }[];
  /** Status for one provider, or `undefined` when no limit is configured. */
  getStatus(providerId: string): ProviderConcurrencyStatus | undefined;
  /** Status for every provider with a configured limit. */
  getStatusAll(): readonly ProviderConcurrencyStatus[];
  /** Stop the watchdog + clear all timers. */
  destroy(): void;
}

// ─── Internal state ───────────────────────────────────────────────────────────

interface Slot {
  readonly conversationId: string;
  readonly acquiredAt: number;
  /** Idempotent release — safe to call from the holder or the watchdog. */
  readonly releaseFn: () => void;
}

interface QueuedWaiter {
  readonly conversationId: string;
  readonly promptStartedAt: number;
  readonly resolve: (release: () => void) => void;
}

interface ProviderState {
  limit: number;
  inFlight: number;
  slots: Map<number, Slot>;
  queue: QueuedWaiter[];
  paused: boolean;
  pausedUntil: number | undefined;
  pauseTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface ConcurrencyManagerOpts {
  /** Monotonic-ish clock (epoch-ms). */
  readonly now: () => number;
  /** Max time a slot may be held before the watchdog reclaims it (ms). */
  readonly slotTimeoutMs: number;
  /** How often the watchdog sweeps (ms). */
  readonly watchdogIntervalMs: number;
  /** Default pause duration when a 429 arrives without Retry-After (ms). */
  readonly defaultPauseMs: number;
  /**
   * Delay after a slot is released before the slot is recycled (ms). During
   * this window `inFlight` stays incremented — a new `acquire` sees the slot
   * as still held and queues. This covers the upstream provider's accounting
   * lag: the provider's `concurrent_sessions` counter may not decrement the
   * instant our stream completes, so re-admitting immediately risks an N+1
   * overshoot. 0 = instant re-admission (no cooldown). Default: 0.
   */
  readonly releaseCooldownMs?: number;
  /** Injected timers (default: global). Override in tests for deterministic time. */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  /** Optional logger for watchdog + pause events. */
  readonly onWatchdogReclaim?: (providerId: string, conversationId: string, heldMs: number) => void;
  readonly onPause?: (providerId: string, durationMs: number) => void;
}

function noopRelease(): void {
  // No limit configured → nothing to release.
}

export function createConcurrencyManager(opts: ConcurrencyManagerOpts): ConcurrencyService {
  const now = opts.now;
  const slotTimeoutMs = opts.slotTimeoutMs;
  const defaultPauseMs = opts.defaultPauseMs;
  const releaseCooldownMs = opts.releaseCooldownMs ?? 0;
  const setTimeout = opts.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeout = opts.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const setInterval = opts.setInterval ?? globalThis.setInterval.bind(globalThis);
  const clearInterval = opts.clearInterval ?? globalThis.clearInterval.bind(globalThis);

  const states = new Map<string, ProviderState>();
  const cooldownTimers = new Set<ReturnType<typeof setTimeout>>();
  let slotIdCounter = 0;

  // ── Slot granting ──────────────────────────────────────────────────────────

  function grantSlot(state: ProviderState, providerId: string, conversationId: string): () => void {
    const id = slotIdCounter++;
    let released = false;
    const releaseFn = () => {
      if (released) return;
      released = true;
      state.slots.delete(id);

      // Recycle the slot: decrement inFlight + grant the next waiter.
      // With a release cooldown > 0, defer this by the cooldown duration so
      // the upstream provider has time to decrement its concurrent_sessions
      // counter — preventing an N+1 overshoot from accounting lag. During the
      // cooldown, inFlight stays incremented, so new acquires queue.
      const recycle = () => {
        state.inFlight--;
        tryGrantNext(providerId);
      };
      if (releaseCooldownMs > 0) {
        const timer = setTimeout(() => {
          cooldownTimers.delete(timer);
          recycle();
        }, releaseCooldownMs);
        cooldownTimers.add(timer);
      } else {
        recycle();
      }
    };
    state.slots.set(id, {
      conversationId,
      acquiredAt: now(),
      releaseFn,
    });
    state.inFlight++;
    return releaseFn;
  }

  function tryGrantNext(providerId: string): void {
    const state = states.get(providerId);
    if (state === undefined) return;
    if (state.paused) return;
    while (state.queue.length > 0 && state.inFlight < state.limit) {
      const waiter = state.queue[0];
      if (waiter === undefined) break;
      state.queue.shift();
      const releaseFn = grantSlot(state, providerId, waiter.conversationId);
      waiter.resolve(releaseFn);
    }
  }

  // ── Watchdog ──────────────────────────────────────────────────────────────────

  function sweep(): void {
    const currentNow = now();
    for (const [providerId, state] of states) {
      for (const [, slot] of state.slots) {
        const heldMs = currentNow - slot.acquiredAt;
        if (heldMs > slotTimeoutMs) {
          opts.onWatchdogReclaim?.(providerId, slot.conversationId, heldMs);
          slot.releaseFn();
        }
      }
    }
  }

  const watchdogTimer = setInterval(sweep, opts.watchdogIntervalMs);

  // ── Public API ─────────────────────────────────────────────────────────────

  const manager: ConcurrencyService = {
    acquire(providerId, conversationId, promptStartedAt, onQueued) {
      const state = states.get(providerId);
      if (state === undefined) {
        // No limit configured → unlimited.
        return Promise.resolve(noopRelease);
      }

      if (!state.paused && state.inFlight < state.limit) {
        return Promise.resolve(grantSlot(state, providerId, conversationId));
      }

      // Cannot grant immediately — the request will be queued.
      // Notify the caller BEFORE creating the Promise so they can emit a
      // "queued" status signal while we're still synchronous.
      onQueued?.();

      // Queue (oldest-agent-first by promptStartedAt).
      return new Promise<() => void>((resolve) => {
        state.queue.push({ conversationId, promptStartedAt, resolve });
        // Keep sorted ascending by promptStartedAt (oldest first).
        // Insertion sort would be O(n), but the queue is typically tiny (<20),
        // so a simple sort is fine and keeps the code simple.
        state.queue.sort((a, b) => a.promptStartedAt - b.promptStartedAt);
      });
    },

    reportRateLimit(providerId, retryAfterMs) {
      const state = states.get(providerId);
      if (state === undefined) return;

      const pauseDuration = retryAfterMs ?? defaultPauseMs;
      state.paused = true;
      state.pausedUntil = now() + pauseDuration;

      if (state.pauseTimer !== undefined) {
        clearTimeout(state.pauseTimer);
      }
      opts.onPause?.(providerId, pauseDuration);
      state.pauseTimer = setTimeout(() => {
        state.paused = false;
        state.pausedUntil = undefined;
        state.pauseTimer = undefined;
        tryGrantNext(providerId);
      }, pauseDuration);
    },

    setLimit(providerId, limit) {
      let state = states.get(providerId);
      if (state === undefined) {
        state = {
          limit,
          inFlight: 0,
          slots: new Map(),
          queue: [],
          paused: false,
          pausedUntil: undefined,
          pauseTimer: undefined,
        };
        states.set(providerId, state);
      } else {
        state.limit = limit;
      }
      // A higher limit may let queued requests through.
      tryGrantNext(providerId);
    },

    getLimit(providerId) {
      return states.get(providerId)?.limit;
    },

    removeLimit(providerId) {
      const state = states.get(providerId);
      if (state === undefined) return;

      // Clear pause.
      state.paused = false;
      state.pausedUntil = undefined;
      if (state.pauseTimer !== undefined) {
        clearTimeout(state.pauseTimer);
        state.pauseTimer = undefined;
      }

      // Grant all queued requests (they become unlimited now).
      while (state.queue.length > 0) {
        const waiter = state.queue[0];
        if (waiter === undefined) break;
        state.queue.shift();
        const releaseFn = grantSlot(state, providerId, waiter.conversationId);
        waiter.resolve(releaseFn);
      }

      // Remove the state. In-flight slots' release functions still work —
      // they close over `state` and call `tryGrantNext` which finds no state
      // and returns early. The watchdog won't sweep removed states.
      states.delete(providerId);
    },

    getLimits() {
      return [...states.entries()].map(([providerId, s]) => ({
        providerId,
        limit: s.limit,
      }));
    },

    getStatus(providerId) {
      const state = states.get(providerId);
      if (state === undefined) return undefined;
      return {
        providerId,
        limit: state.limit,
        inFlight: state.inFlight,
        queued: state.queue.length,
        paused: state.paused,
        ...(state.pausedUntil !== undefined ? { pausedUntil: state.pausedUntil } : {}),
      };
    },

    getStatusAll() {
      return [...states.keys()]
        .map((providerId) => manager.getStatus(providerId))
        .filter((s): s is ProviderConcurrencyStatus => s !== undefined);
    },

    destroy() {
      clearInterval(watchdogTimer);
      for (const timer of cooldownTimers) {
        clearTimeout(timer);
      }
      cooldownTimers.clear();
      for (const state of states.values()) {
        if (state.pauseTimer !== undefined) {
          clearTimeout(state.pauseTimer);
        }
      }
      states.clear();
    },
  };

  return manager;
}
