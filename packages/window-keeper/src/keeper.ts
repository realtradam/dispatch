/**
 * window-keeper loop — decision logic with every effect injected (`now`,
 * timers, usage report, kick). All state lives in the returned closure; there
 * is no module state, so a keeper's schedule is reproducible from its inputs.
 *
 * The keeper never bypasses the account-usage service's spacing: it makes at
 * most one usage check per window end. Failed kick sequences back off
 * exponentially (10 min, 20 min, 40 min, … capped at 6 h).
 */
import type { Logger } from "@dispatch/kernel";
import type { AccountUsageReport } from "@dispatch/transport-contract";
import {
  BOOT_DELAY_MS,
  CHECK_DELAY_MS,
  classifyReport,
  FALLBACK_KICK_DELAY_MS,
  kickBackoffMs,
  MAX_REKICKS,
  MAX_SLEEP_MS,
  parseClockOffset,
  REKICK_INTERVAL_MS,
  UNKNOWN_RECHECK_MS,
  windowIsRunning,
} from "./core.js";

/** Result of one minimal request sent to start a window. */
export type KickOutcome = "ok" | "error" | "unavailable";

export interface WindowKeeperDeps {
  /** For log attributes: the profile id. */
  readonly provider: string;
  /** The account-usage limit row to classify. */
  readonly limitId: string;
  readonly parseReset: (
    headers: Readonly<Record<string, string>>,
    serverNow: number,
  ) => number | null;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** A refreshed usage report for this provider, or null. Must not throw. */
  readonly getReport: () => Promise<AccountUsageReport | null>;
  /** Send one minimal request. Must not throw. */
  readonly kick: () => Promise<KickOutcome>;
  readonly logger: Logger;
}

export interface WindowKeeper {
  /** Idempotent. Starts (or restarts after stop) the loop. */
  readonly start: () => void;
  /** Idempotent. Cancels everything pending. */
  readonly stop: () => void;
  /** Feed every inference response's headers for this provider (lower-cased keys). */
  readonly onResponseHeaders: (headers: Readonly<Record<string, string>>) => void;
}

export function createWindowKeeper(deps: WindowKeeperDeps): WindowKeeper {
  /** End of the running window in server time; null = unknown. */
  let resetsAt: number | null = null;
  let clockOffsetMs = 0;
  let busy = false;
  let active = false;
  /** Bumped by every start/stop; stale continuations compare against it. */
  let generation = 0;
  /** Consecutive failed kick sequences. */
  let failures = 0;
  let pending: unknown = null;
  let hasPending = false;

  const serverNow = (): number => deps.now() + clockOffsetMs;

  function clearPending(): void {
    if (!hasPending) return;
    hasPending = false;
    const handle = pending;
    pending = null;
    deps.clearTimer(handle);
  }

  function isCurrent(token: number): boolean {
    return active && generation === token;
  }

  /** Replace the single pending timer with one that fires `fn` after max(0, ms). */
  function sleepThen(ms: number, fn: () => void): void {
    if (!active) return;
    clearPending();
    const token = generation;
    hasPending = true;
    pending = deps.setTimer(
      () => {
        hasPending = false;
        pending = null;
        if (!isCurrent(token)) return;
        fn();
      },
      Math.max(0, ms),
    );
  }

  function waitSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      sleepThen(ms, resolve);
    });
  }

  async function runKickSequence(): Promise<void> {
    const token = generation;
    let attempt = 0;
    for (;;) {
      if (!isCurrent(token)) return;
      // Ordinary traffic may have started a window while we were waiting.
      if (windowIsRunning(resetsAt, serverNow())) {
        failures = 0;
        busy = false;
        sleepThen(0, evaluate);
        return;
      }
      deps.logger.info("window-keeper: starting a window", {
        provider: deps.provider,
        attempt,
      });
      const outcome = await deps.kick();
      if (!isCurrent(token)) return;
      const currentReset = resetsAt;
      if (currentReset !== null && windowIsRunning(currentReset, serverNow())) {
        deps.logger.info("window-keeper: window started", {
          provider: deps.provider,
          resetsAt: new Date(currentReset).toISOString(),
          attempts: attempt + 1,
        });
        failures = 0;
        busy = false;
        sleepThen(0, evaluate);
        return;
      }
      if (outcome === "unavailable" || attempt === MAX_REKICKS) {
        failures += 1;
        const retryInMs = kickBackoffMs(failures);
        deps.logger.warn("window-keeper: could not start a window", {
          provider: deps.provider,
          outcome,
          attempts: attempt + 1,
          retryInMs,
        });
        resetsAt = null;
        busy = false;
        sleepThen(retryInMs, evaluate);
        return;
      }
      attempt += 1;
      await waitSleep(REKICK_INTERVAL_MS);
      if (!isCurrent(token)) return;
    }
  }

  async function evaluate(): Promise<void> {
    if (busy || !active) return;
    const token = generation;
    const firstServerNow = serverNow();
    if (resetsAt !== null && firstServerNow < resetsAt + CHECK_DELAY_MS) {
      sleepThen(Math.min(resetsAt + CHECK_DELAY_MS - firstServerNow, MAX_SLEEP_MS), evaluate);
      return;
    }
    busy = true;
    const dueReset = resetsAt;
    const report = await deps.getReport();
    if (!isCurrent(token)) return;
    const localNow = deps.now();
    const currentServerNow = localNow + clockOffsetMs;
    const verdict = classifyReport(report, deps.limitId, currentServerNow, localNow);
    switch (verdict.kind) {
      case "running":
        resetsAt = verdict.resetsAt;
        failures = 0;
        busy = false;
        sleepThen(0, evaluate);
        return;
      case "blocked":
        resetsAt = null;
        busy = false;
        deps.logger.info("window-keeper: blocked by usage limit", {
          provider: deps.provider,
          limitId: verdict.limitId,
          label: verdict.label,
          until: new Date(verdict.until).toISOString(),
        });
        sleepThen(
          Math.min(verdict.until + CHECK_DELAY_MS - currentServerNow, MAX_SLEEP_MS),
          evaluate,
        );
        return;
      case "idle":
        await runKickSequence();
        return;
      case "unknown":
        if (dueReset !== null) {
          // The window end was known but this check gave no evidence: kick after
          // a short grace period without a second check (one check per window end).
          sleepThen(Math.max(0, dueReset + FALLBACK_KICK_DELAY_MS - serverNow()), runKickSequence);
        } else {
          busy = false;
          sleepThen(UNKNOWN_RECHECK_MS, evaluate);
        }
        return;
    }
  }

  function start(): void {
    if (active) return;
    active = true;
    generation += 1;
    resetsAt = null;
    busy = false;
    failures = 0;
    sleepThen(BOOT_DELAY_MS, evaluate);
  }

  function stop(): void {
    if (!active) return;
    active = false;
    generation += 1;
    clearPending();
    busy = false;
  }

  function onResponseHeaders(headers: Readonly<Record<string, string>>): void {
    const offset = parseClockOffset(headers, deps.now());
    if (offset !== null) clockOffsetMs = offset;
    const now = serverNow();
    const reset = deps.parseReset(headers, now);
    if (reset !== null && reset > now) {
      resetsAt = reset;
      if (active && !busy) sleepThen(0, evaluate);
    }
  }

  return { start, stop, onResponseHeaders };
}
