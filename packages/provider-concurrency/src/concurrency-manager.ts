/**
 * In-memory per-provider concurrency limiter.
 *
 * Tracks and limits how many concurrent API requests (token-generating
 * requests) are in flight per provider. When the limit is reached, additional
 * requests queue and are granted slots based on oldest-agent-first priority
 * (the agent whose current prompt started the longest ago wins the next slot).
 *
 * A watchdog reclaims slots held beyond a timeout (deadlock / stuck-agent
 * recovery). 429 backoff pauses a provider's queue for a configurable duration
 * AND adaptively reduces the effective limit by 1 (one-way, persisted) so the
 * resumed queue runs with headroom instead of re-overshooting.
 *
 * ── Usage gate (anti-overshoot) ──
 * When a `fetchUsage` callback is injected, before admitting a QUEUED agent the
 * manager polls the provider's upstream `concurrent_sessions` count and grants
 * only when it is below the configured limit. This composes with the release
 * cooldown: release → cooldown delay → usage-gate poll → grant (only if upstream
 * has room). A waiter is re-checked on two triggers (either one): another agent
 * releases a slot (immediate re-poll, restarting the 1s countdown) or a 1s
 * fallback timer elapses (in case the upstream count drops on its own). Each
 * successful poll admits at most ONE queued waiter (each admission pushes the
 * upstream count back toward the limit), so additional waiters are admitted on
 * subsequent repolls. When `fetchUsage` is absent or returns `undefined`, the
 * gate is skipped and the manager falls back to cooldown-only recycling.
 *
 * This module is the PURE decision logic. It takes an injected clock (`now`),
 * injected timers (`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`),
 * and an injected usage-poll effect (`fetchUsage`) so it is fully testable with
 * deterministic fake time + a fake fetcher. The extension layer wires real
 * timers + the host's provider registry.
 */

import type { ProviderUsage } from "@dispatch/kernel";

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
  /**
   * Per-slot release cooldown (ms) — how long a recycled slot is held before the
   * next waiter is admitted. Covers the upstream provider's accounting lag.
   * Configurable + persisted per provider.
   */
  readonly cooldownMs: number;
  /**
   * Whether the limit was auto-reduced by a 429 (adaptive headroom). The user
   * restores the limit manually (PUT /concurrency/limits/:providerId) which
   * clears this flag. The frontend renders a visible notice when `true`.
   */
  readonly autoReduced: boolean;
  /** The original limit before auto-reduction (present only when autoReduced). */
  readonly autoReducedFrom?: number;
  /**
   * A human-readable notice string for the frontend to render as a banner when
   * the limit was auto-reduced. Present only when `autoReduced` is true.
   */
  readonly notice?: string;
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
   * `retryAfterMs` (or a default duration when omitted), AND reduces the
   * provider's effective limit by 1 (one-way, down to a minimum of 1) so the
   * resumed queue runs with headroom. Queued and in-flight requests are
   * otherwise unaffected; new `acquire` calls block until the pause expires.
   */
  reportRateLimit(providerId: string, retryAfterMs?: number): void;
}

/**
 * The full service surface (limiter + config + status) for HTTP routes.
 */
export interface ConcurrencyService extends ConcurrencyLimiter {
  /** Set the concurrency limit for a provider (MANUAL — clears the auto-reduce notice). Creates the state if new. */
  setLimit(providerId: string, limit: number): void;
  /**
   * Restore a persisted limit on startup WITHOUT clearing the auto-reduce
   * notice (Bug 3). Unlike {@link setLimit} (a manual user action that signals
   * "the user took control"), this seeds state from disk: it applies the limit
   * and, when `autoReducedFrom` is provided, re-marks the state as auto-reduced
   * so the frontend banner survives a restart. Used by the extension's
   * `loadLimits`/`loadAutoReduce` on activate.
   */
  restoreLimit(providerId: string, limit: number, autoReducedFrom?: number): void;
  /** Get the configured limit, or `undefined` when none. */
  getLimit(providerId: string): number | undefined;
  /** Remove the limit for a provider (makes it unlimited). */
  removeLimit(providerId: string): void;
  /** All configured limits as `{ providerId, limit }` entries. */
  getLimits(): readonly { providerId: string; limit: number }[];
  /**
   * Set the release cooldown (ms) for a provider. Applied to subsequently
   * recycled slots; in-flight cooldown timers keep their original duration.
   * Creates the state if new (with no limit — unlimited but cooldown-gated).
   */
  setCooldown(providerId: string, cooldownMs: number): void;
  /** Get the configured cooldown (ms), or `undefined` when none was set. */
  getCooldown(providerId: string): number | undefined;
  /** All configured cooldowns as `{ providerId, cooldownMs }` entries. */
  getCooldowns(): readonly { providerId: string; cooldownMs: number }[];
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
  /** Per-provider release cooldown (ms). Defaults to the manager opt; settable at runtime. */
  cooldownMs: number;
  // ── Adaptive headroom ──
  autoReduced: boolean;
  autoReducedFrom: number | undefined;
  notice: string | undefined;
  // ── Usage-gate state ──
  /** A usage poll is in flight for this provider (prevents overlapping polls). */
  gatePolling: boolean;
  /** Another repoll trigger fired while a poll was in flight → re-poll on completion. */
  gateRepollRequested: boolean;
  /** The 1s fallback repoll timer (re-checked periodically even without releases). */
  gateRepollTimer: ReturnType<typeof setTimeout> | undefined;
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
   * Default delay after a slot is released before the slot is recycled (ms).
   * During this window `inFlight` stays incremented — a new `acquire` sees the
   * slot as still held and queues. This covers the upstream provider's
   * accounting lag: the provider's `concurrent_sessions` counter may not
   * decrement the instant our stream completes, so re-admitting immediately
   * risks an N+1 overshoot. 0 = instant re-admission (no cooldown). Default: 0.
   * Per-provider overrides via `setCooldown`.
   */
  readonly releaseCooldownMs?: number;
  /**
   * Injected usage-poll effect. When present, before admitting a QUEUED agent
   * the manager calls this and grants only when `concurrentSessions` is below
   * the configured limit (usage gate). When absent, the manager falls back to
   * cooldown-only slot recycling. Injected (like `now`/`setTimeout`) so the
   * manager stays unit-testable with a fake fetcher; never hardcodes `fetch`.
   */
  readonly fetchUsage?: (providerId: string) => Promise<ProviderUsage | undefined>;
  /** Injected timers (default: global). Override in tests for deterministic time. */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  /** Optional logger for watchdog + pause + auto-reduce events. */
  readonly onWatchdogReclaim?: (providerId: string, conversationId: string, heldMs: number) => void;
  readonly onPause?: (providerId: string, durationMs: number) => void;
  /** Fired when a 429 adaptively reduces a provider's limit (for persistence + logging). */
  readonly onLimitReduced?: (providerId: string, newLimit: number, oldLimit: number) => void;
  /**
   * Fired when the injected `fetchUsage` throws (network/parse failure beyond the
   * graceful-undefined path). The manager treats a thrown poll as "no usage info"
   * (cooldown-only fallback) — this callback is for WARN-level logging only. The
   * poll never becomes an unhandled rejection.
   */
  readonly onUsagePollError?: (providerId: string, err: unknown) => void;
}

/** Min interval between usage-gate fallback repolls (ms). The release trigger is immediate. */
const USAGE_REPOLL_INTERVAL_MS = 1000;
/** Minimum the limit may be auto-reduced to (never 0). */
const MIN_LIMIT = 1;

function noopRelease(): void {
  // No limit configured → nothing to release.
}

export function createConcurrencyManager(opts: ConcurrencyManagerOpts): ConcurrencyService {
  const now = opts.now;
  const slotTimeoutMs = opts.slotTimeoutMs;
  const defaultPauseMs = opts.defaultPauseMs;
  const defaultCooldownMs = opts.releaseCooldownMs ?? 0;
  const fetchUsage = opts.fetchUsage;
  const setTimeout = opts.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeout = opts.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const setInterval = opts.setInterval ?? globalThis.setInterval.bind(globalThis);
  const clearInterval = opts.clearInterval ?? globalThis.clearInterval.bind(globalThis);

  const states = new Map<string, ProviderState>();
  const cooldownOverrides = new Map<string, number>();
  const cooldownTimers = new Set<ReturnType<typeof setTimeout>>();
  let slotIdCounter = 0;

  function makeState(limit: number, cooldownMs: number): ProviderState {
    return {
      limit,
      inFlight: 0,
      slots: new Map(),
      queue: [],
      paused: false,
      pausedUntil: undefined,
      pauseTimer: undefined,
      cooldownMs,
      autoReduced: false,
      autoReducedFrom: undefined,
      notice: undefined,
      gatePolling: false,
      gateRepollRequested: false,
      gateRepollTimer: undefined,
    };
  }

  /** Seed the cooldown for new state from any pending override (else the default). */
  function seedCooldown(providerId: string): number {
    return cooldownOverrides.get(providerId) ?? defaultCooldownMs;
  }

  // ── Slot granting ──────────────────────────────────────────────────────────

  function grantSlot(state: ProviderState, providerId: string, conversationId: string): () => void {
    const id = slotIdCounter++;
    let released = false;
    const releaseFn = () => {
      if (released) return;
      released = true;
      state.slots.delete(id);

      // Recycle the slot: free its inFlight count + attempt to grant the next
      // waiter. With a release cooldown > 0, defer this by the cooldown duration
      // so the upstream provider has time to decrement its concurrent_sessions
      // counter — preventing an N+1 overshoot from accounting lag. During the
      // cooldown, inFlight stays incremented, so new acquires queue.
      const recycle = () => {
        if (fetchUsage === undefined || state.queue.length === 0) {
          // No usage gate, OR no one waiting (the lag window is irrelevant when
          // there is no waiter to admit) → free the slot immediately. With no
          // gate, also drain the queue (grant all that fit).
          state.inFlight--;
          if (fetchUsage === undefined) grantLoop(state, providerId);
          return;
        }
        // Usage gate configured + a waiter exists → hold inFlight inflated
        // DURING the poll window (gatePolling is set synchronously inside
        // pollAndGrant, the inFlight decrement is deferred until the poll
        // resolves). This closes the overshoot gap: a concurrent acquire arriving
        // between the cooldown firing and the poll resolving sees the slot as
        // still occupied (inFlight >= limit) and queues instead of fast-pathing.
        // pollAndGrant(decrementOnPoll=true) decrements inFlight after observing
        // the post-release upstream state, then admits one waiter if there is room.
        void pollAndGrant(providerId, state, true);
      };
      if (state.cooldownMs > 0) {
        const timer = setTimeout(() => {
          cooldownTimers.delete(timer);
          recycle();
        }, state.cooldownMs);
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

  /**
   * Grant queued waiters WITHOUT the usage gate (the fast path used when no
   * `fetchUsage` is configured, or as the cooldown-only fallback when a poll
   * returns no usage info). Grants while there is internal room
   * (`inFlight < limit`). Synchronous.
   */
  function grantLoop(state: ProviderState, providerId: string): void {
    while (state.queue.length > 0 && state.inFlight < state.limit) {
      const waiter = state.queue[0];
      if (waiter === undefined) break;
      state.queue.shift();
      const releaseFn = grantSlot(state, providerId, waiter.conversationId);
      waiter.resolve(releaseFn);
    }
    // If the queue drained, no need to keep the usage-gate fallback timer armed.
    if (state.queue.length === 0 && state.gateRepollTimer !== undefined) {
      clearTimeout(state.gateRepollTimer);
      state.gateRepollTimer = undefined;
    }
  }

  /**
   * Admit exactly ONE queued waiter (the front of the queue), if there is
   * internal room. Used by the usage-gated path so each admission is confirmed
   * by a FRESH upstream poll — admitting multiple from a single (possibly stale)
   * poll risks an N+1 overshoot when the upstream count lags. Additional waiters
   * are admitted on subsequent repolls.
   */
  function grantOne(state: ProviderState, providerId: string): void {
    if (state.queue.length === 0) return;
    if (state.inFlight >= state.limit) return;
    const waiter = state.queue[0];
    if (waiter === undefined) return;
    state.queue.shift();
    const releaseFn = grantSlot(state, providerId, waiter.conversationId);
    waiter.resolve(releaseFn);
    // If the queue drained, disarm the fallback timer.
    if (state.queue.length === 0 && state.gateRepollTimer !== undefined) {
      clearTimeout(state.gateRepollTimer);
      state.gateRepollTimer = undefined;
    }
  }

  /**
   * Invoke the injected `fetchUsage`, treating ANY thrown error as "no usage
   * info available" (cooldown-only fallback) — so a throwing `getUsage()` never
   * becomes an unhandled rejection. The `onUsagePollError` opt is fired for
   * WARN-level logging. Returns `undefined` on throw (Bug 2 fix).
   */
  async function safeFetchUsage(providerId: string): Promise<ProviderUsage | undefined> {
    if (fetchUsage === undefined) return undefined;
    try {
      return await fetchUsage(providerId);
    } catch (err) {
      opts.onUsagePollError?.(providerId, err);
      return undefined;
    }
  }

  /**
   * Drain the queue, gated on the upstream usage poll when `fetchUsage` is
   * configured. Called from setLimit, pause-expiry, and the repoll timer (NOT
   * from release — that goes through {@link recycleGated}, which holds inFlight
   * inflated during the poll). Async because the usage poll is an injected I/O
   * effect; callers fire-and-forget the returned promise.
   *
   * The fast-path immediate grant in `acquire` (when `inFlight < limit`) is
   * disabled while `gatePolling` is true — `acquire` queues instead, so a
   * concurrent caller cannot sneak through the accounting-lag / poll window
   * (anti-overshoot). When no poll is in flight the fast-path is safe: the
   * cooldown keeps `inFlight` inflated during the lag window, and a recycle
   * sets `gatePolling` synchronously before decrementing.
   *
   * Each successful poll admits at most ONE queued waiter (each admission pushes
   * the upstream count back toward the limit); additional waiters are admitted
   * on subsequent repolls (release triggers an immediate re-poll; the 1s
   * fallback timer covers an upstream count that drops on its own).
   */
  async function tryGrantNext(providerId: string): Promise<void> {
    const state = states.get(providerId);
    if (state === undefined) return;
    if (state.paused) return;
    if (state.queue.length === 0) return;
    if (state.inFlight >= state.limit) return; // no internal room

    // No usage gate → immediate grant loop (original behavior).
    if (fetchUsage === undefined) {
      grantLoop(state, providerId);
      return;
    }

    // Avoid overlapping polls for this provider. A poll is already in flight;
    // mark that another trigger fired so it re-polls on completion.
    if (state.gatePolling) {
      state.gateRepollRequested = true;
      return;
    }

    await pollAndGrant(providerId, state);
  }

  /**
   * Shared poll-then-admit. `decrementOnPoll` is true for the recycle path
   * (the released slot's inFlight decrement is deferred until the poll resolves,
   * holding inFlight inflated so concurrent acquires queue — anti-overshoot) and
   * false for the drain path (setLimit/pause-expiry/repoll — no slot to account).
   * Admits at most ONE waiter on a successful poll.
   */
  async function pollAndGrant(
    providerId: string,
    state: ProviderState,
    decrementOnPoll = false,
  ): Promise<void> {
    state.gatePolling = true;
    try {
      const snapshot = await safeFetchUsage(providerId);

      // For the recycle path, the released slot is now truly freed (the poll
      // has observed the post-release upstream state).
      if (decrementOnPoll) {
        state.inFlight--;
      }

      // Conditions may have changed during the async poll — re-check.
      if (state.paused) return;
      if (state.queue.length === 0) return;

      if (snapshot === undefined) {
        // No usage info available → fall back to cooldown-only (grant one).
        grantOne(state, providerId);
        return;
      }

      if (snapshot.concurrentSessions < state.limit) {
        // Upstream has room — admit exactly ONE queued waiter.
        grantOne(state, providerId);
      }
      // else: upstream at/over limit → keep queued; repoll timer handles retry.
    } finally {
      state.gatePolling = false;
      // (Re)arm the 1s fallback timer while waiters remain queued, so an
      // upstream count that drops on its own is still detected.
      armGateRepoll(providerId, state);
      if (state.gateRepollRequested) {
        state.gateRepollRequested = false;
        // A release (or other trigger) fired during the poll → re-poll now.
        void tryGrantNext(providerId);
      }
    }
  }

  function armGateRepoll(providerId: string, state: ProviderState): void {
    // Only arm while there are queued waiters (otherwise no work to re-check).
    if (state.queue.length === 0) {
      if (state.gateRepollTimer !== undefined) {
        clearTimeout(state.gateRepollTimer);
        state.gateRepollTimer = undefined;
      }
      return;
    }
    if (state.gateRepollTimer !== undefined) {
      clearTimeout(state.gateRepollTimer);
    }
    state.gateRepollTimer = setTimeout(() => {
      state.gateRepollTimer = undefined;
      void tryGrantNext(providerId);
    }, USAGE_REPOLL_INTERVAL_MS);
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

  // ── Adaptive headroom ──────────────────────────────────────────────────────

  function clearAutoReduce(state: ProviderState): void {
    state.autoReduced = false;
    state.autoReducedFrom = undefined;
    state.notice = undefined;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  const manager: ConcurrencyService = {
    acquire(providerId, conversationId, promptStartedAt, onQueued) {
      const state = states.get(providerId);
      if (state === undefined) {
        // No limit configured → unlimited.
        return Promise.resolve(noopRelease);
      }

      if (!state.paused && state.inFlight < state.limit) {
        // Usage-gate anti-overshoot: while a recycle-poll is in flight, the
        // inFlight count is momentarily unreliable (a released slot's decrement
        // is deferred until the poll resolves — see pollAndGrant). A concurrent
        // caller that fast-pathed now could overshoot the upstream limit before
        // the poll confirms room. So route it through the queue instead; the
        // in-flight poll will re-check (gateRepollRequested) and admit it once
        // upstream confirms room. When no poll is in flight the fast-path is
        // safe (the cooldown keeps inFlight inflated through the lag window).
        if (fetchUsage !== undefined && state.gatePolling) {
          // falls through to the queue path below
        } else {
          return Promise.resolve(grantSlot(state, providerId, conversationId));
        }
      }

      // Cannot grant immediately — the request will be queued.
      // Notify the caller BEFORE creating the Promise so they can emit a
      // "queued" status signal while we're still synchronous.
      onQueued?.();

      // Queue (oldest-agent-first by promptStartedAt).
      return new Promise<() => void>((resolve) => {
        state.queue.push({ conversationId, promptStartedAt, resolve });
        // Keep sorted ascending by promptStartedAt (oldest first).
        state.queue.sort((a, b) => a.promptStartedAt - b.promptStartedAt);
        // If the usage gate is active, ensure the fallback repoll timer is
        // armed (a release may not come for a while; the 1s timer covers an
        // upstream count that drops on its own).
        if (fetchUsage !== undefined) {
          armGateRepoll(providerId, state);
        }
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

      // Adaptive headroom: reduce the effective limit by 1 (one-way, min 1) so
      // the resumed queue runs with headroom instead of re-overshooting. The
      // reduction is persisted + surfaced (via onLimitReduced + status).
      if (state.limit > MIN_LIMIT) {
        const oldLimit = state.limit;
        state.limit = Math.max(MIN_LIMIT, state.limit - 1);
        if (!state.autoReduced) {
          state.autoReduced = true;
          state.autoReducedFrom = oldLimit;
        }
        state.notice =
          `Concurrency limit auto-reduced to ${state.limit} after a 429 — ` +
          "restore manually when ready.";
        opts.onLimitReduced?.(providerId, state.limit, oldLimit);
      }

      state.pauseTimer = setTimeout(() => {
        state.paused = false;
        state.pausedUntil = undefined;
        state.pauseTimer = undefined;
        void tryGrantNext(providerId);
      }, pauseDuration);
    },

    setLimit(providerId, limit) {
      let state = states.get(providerId);
      if (state === undefined) {
        state = makeState(limit, seedCooldown(providerId));
        states.set(providerId, state);
      } else {
        state.limit = limit;
        // A MANUAL limit set clears the auto-reduce notice (the user took control).
        clearAutoReduce(state);
      }
      // A higher limit may let queued requests through.
      void tryGrantNext(providerId);
    },

    restoreLimit(providerId, limit, autoReducedFrom) {
      // Startup restoration (Bug 3): seed state from disk WITHOUT the manual
      // "user took control" semantics, so a persisted auto-reduced limit keeps
      // its notice/banner across a restart. When autoReducedFrom is provided,
      // re-mark the state as auto-reduced (rebuild the notice).
      let state = states.get(providerId);
      if (state === undefined) {
        state = makeState(limit, seedCooldown(providerId));
        states.set(providerId, state);
      } else {
        state.limit = limit;
      }
      if (autoReducedFrom !== undefined && autoReducedFrom > limit) {
        state.autoReduced = true;
        state.autoReducedFrom = autoReducedFrom;
        state.notice =
          `Concurrency limit auto-reduced to ${limit} after a 429 — ` +
          "restore manually when ready.";
      }
      // A higher limit may let queued requests through.
      void tryGrantNext(providerId);
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
      // Clear usage-gate fallback timer.
      if (state.gateRepollTimer !== undefined) {
        clearTimeout(state.gateRepollTimer);
        state.gateRepollTimer = undefined;
      }
      clearAutoReduce(state);

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

    setCooldown(providerId, cooldownMs) {
      // A cooldown is only meaningful WITH a limit (it gates slot recycling,
      // which only happens under a limit). But we store the override regardless
      // so it applies the moment a limit IS set — and so a persisted cooldown
      // restored before a limit does NOT impose a limit (setCooldown never
      // creates a state). If a state already exists, update it live.
      cooldownOverrides.set(providerId, cooldownMs);
      const state = states.get(providerId);
      if (state !== undefined) {
        state.cooldownMs = cooldownMs;
      }
    },

    getCooldown(providerId) {
      const state = states.get(providerId);
      if (state !== undefined) return state.cooldownMs;
      return cooldownOverrides.get(providerId);
    },

    getCooldowns() {
      // Merge: states (cooldown from state.cooldownMs) + pending overrides with no state.
      const seen = new Set<string>();
      const out: { providerId: string; cooldownMs: number }[] = [];
      for (const [providerId, s] of states) {
        seen.add(providerId);
        out.push({ providerId, cooldownMs: s.cooldownMs });
      }
      for (const [providerId, cooldownMs] of cooldownOverrides) {
        if (!seen.has(providerId)) {
          out.push({ providerId, cooldownMs });
        }
      }
      return out;
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
        cooldownMs: state.cooldownMs,
        autoReduced: state.autoReduced,
        ...(state.pausedUntil !== undefined ? { pausedUntil: state.pausedUntil } : {}),
        ...(state.autoReducedFrom !== undefined ? { autoReducedFrom: state.autoReducedFrom } : {}),
        ...(state.notice !== undefined ? { notice: state.notice } : {}),
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
        if (state.gateRepollTimer !== undefined) {
          clearTimeout(state.gateRepollTimer);
        }
      }
      states.clear();
    },
  };

  return manager;
}
