/**
 * Periodic memory telemetry — leak-localization edge effect.
 *
 * Owns the timers (setInterval) that periodically log process.memoryUsage()
 * so RSS growth can be correlated with active conversations/turns and the
 * leaking subsystem pinpointed. This is the composition-root edge effect
 * (AGENTS.md: timers are edge effects owned by host-bin, NOT the kernel).
 *
 * All effects are injected (sampler, GC, clock, logger, active-conversation
 * count) so the timer logic is fully testable — tests pass fakes and assert
 * the emitted log calls, never waiting on a real wall clock. No ambient
 * state (P3): the timers are owned explicitly and returned as a `stop()`
 * handle that the composition root clears on shutdown.
 *
 * The per-turn before/after sampling lives in session-orchestrator (it wraps
 * the stream boundary); this module owns the PERIODIC baseline + GC logging.
 */

import type { Logger } from "@dispatch/kernel";
import {
  type MemorySample,
  memoryDelta,
  memorySampleAttributes,
} from "@dispatch/session-orchestrator";

/** Default periodic sample interval: every 60s. */
export const DEFAULT_MEMORY_SAMPLE_INTERVAL_MS = 60_000;

/** Default GC interval: every 5 min (longer than the sample interval). */
export const DEFAULT_GC_INTERVAL_MS = 5 * 60_000;

/**
 * Deps injected into {@link startMemoryTelemetry}. Every effect is explicit so
 * the timer logic is reproducible from its inputs (no ambient state, P3) and
 * testable without a real clock or process.
 */
export interface MemoryTelemetryDeps {
  /** Logger (auto-scoped to host-bin by the composition root). */
  readonly logger: Logger;
  /** Edge effect: capture a {@link MemorySample} now (process.memoryUsage()). */
  readonly sampleMemory: () => MemorySample;
  /**
   * Edge effect: run a full GC cycle. In production this is `() =>
   * Bun.gc(true)`; tests pass a no-op or a counting fake. Used on the longer
   * GC interval to distinguish live retained objects from GC fragmentation.
   */
  readonly gc: () => void;
  /**
   * The number of conversations currently driving a turn (from the
   * session-orchestrator's activeConversations set). Tags each periodic
   * sample so growth can be attributed to the streaming/turn path vs an idle
   * baseline.
   */
  readonly getActiveConversationCount: () => number;
  /** Periodic sample interval (ms). Defaults to 60s. */
  readonly sampleIntervalMs?: number;
  /** GC interval (ms). Defaults to 5 min. */
  readonly gcIntervalMs?: number;
  /**
   * Injected timer scheduler (defaults to global setInterval). Tests pass a
   * fake to drive ticks deterministically without real wall-clock waits. The
   * handle type is opaque (the same type {@link clearInterval} accepts).
   */
  readonly setInterval?: (fn: () => void, ms: number) => MemoryTimerHandle;
  /** Injected timer clearer (defaults to global clearInterval). */
  readonly clearInterval?: (handle: MemoryTimerHandle | undefined) => void;
}

/** Opaque timer handle shared by {@link MemoryTelemetryDeps.setInterval} / clearInterval. */
export type MemoryTimerHandle = ReturnType<typeof globalThis.setInterval>;

/** Handle returned by {@link startMemoryTelemetry} to stop the timers. */
export interface MemoryTelemetryHandle {
  /** Stop both timers. Idempotent. Called by the composition root on shutdown. */
  readonly stop: () => void;
}

/**
 * Start periodic memory telemetry. Logs process.memoryUsage() every
 * `sampleIntervalMs` (default 60s) tagged with the active-conversation count,
 * and every `gcIntervalMs` (default 5 min) runs `gc()` and logs RSS
 * before/after to distinguish live retained objects from GC fragmentation.
 *
 * Returns a `stop()` handle that clears both timers. The composition root
 * (host-bin main) owns this handle and calls `stop()` on shutdown so the
 * timers never leak across a restart.
 *
 * Pure decision logic: {@link buildPeriodicAttributes} /
 * {@link buildGcAttributes} are exported separately for unit testing.
 */
export function startMemoryTelemetry(deps: MemoryTelemetryDeps): MemoryTelemetryHandle {
  const sampleIntervalMs = deps.sampleIntervalMs ?? DEFAULT_MEMORY_SAMPLE_INTERVAL_MS;
  const gcIntervalMs = deps.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
  const setIntervalFn = deps.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval;

  let gcHandle: MemoryTimerHandle | undefined;

  // Periodic sample: log rss/heap/external/arrayBuffers + active-conversation
  // count every 60s. Correlates RSS growth with active turns so the leak can
  // be attributed to the streaming path vs an idle baseline.
  const sampleHandle: MemoryTimerHandle | undefined = setIntervalFn(() => {
    const sample = deps.sampleMemory();
    const activeConversations = deps.getActiveConversationCount();
    deps.logger.info("memory:periodic", buildPeriodicAttributes(sample, activeConversations));
  }, sampleIntervalMs);

  // GC log: on a longer interval, force a full GC and log RSS before/after.
  // A small/no drop after gc means the memory is LIVE (retained objects — the
  // leak); a large drop means it was GC fragmentation (reclaimable). This
  // distinguishes the two failure modes the crash investigation flagged.
  gcHandle = setIntervalFn(() => {
    const before = deps.sampleMemory();
    deps.gc();
    const after = deps.sampleMemory();
    deps.logger.info("memory:gc", buildGcAttributes(before, after));
  }, gcIntervalMs);

  let stopped = false;
  return {
    stop() {
      if (stopped) return; // idempotent — safe to call on every shutdown path
      stopped = true;
      clearIntervalFn(sampleHandle);
      clearIntervalFn(gcHandle);
    },
  };
}

/**
 * Pure: build the logger attributes for a periodic sample. Exported for unit
 * testing (no I/O, no clock). The `activeConversations` count tags the sample
 * so growth can be attributed to the streaming/turn path vs idle baseline.
 */
export function buildPeriodicAttributes(
  sample: MemorySample,
  activeConversations: number,
): ReturnType<typeof memorySampleAttributes> & { activeConversations: number } {
  return { ...memorySampleAttributes(sample), activeConversations };
}

/**
 * Pure: build the logger attributes for a GC sample. Exported for unit testing.
 * Carries the absolute after-sample plus the `reclaimed` delta
 * (`before - after`): a POSITIVE `reclaimedRssMB` means GC freed memory
 * (fragmentation, reclaimable); near-zero/negative means the memory is LIVE
 * (retained objects — the leak). This distinguishes the two failure modes the
 * crash investigation flagged.
 */
export function buildGcAttributes(
  before: MemorySample,
  after: MemorySample,
): ReturnType<typeof memorySampleAttributes> {
  // reclaimed = before - after (how much GC freed). memoryDelta(a, b) = b - a,
  // so pass (after, before) to get before - after.
  return {
    ...memorySampleAttributes(after),
    ...memorySampleAttributes(memoryDelta(after, before), "reclaimed"),
  };
}
