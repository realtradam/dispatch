/**
 * Shutdown controller — the exit-code DECISION logic for the server process.
 *
 * Why this exists: production runs the server under systemd with
 * `Restart=on-failure` (systemd/dispatch.service). systemd restarts only on a
 * NON-ZERO exit, a signal, or a timeout — a clean exit 0 is treated as an
 * intentional stop. The old `shutdown()` in main.ts always called
 * `process.exit(0)`, including on the `uncaughtException` path, so a crashed
 * server stayed down until someone restarted it by hand. It could also hang
 * forever if cleanup never settled (no exit at all → systemd sees a running,
 * broken process).
 *
 * Contract (see notes/host-crash-restart-plan.md):
 * - SIGINT / SIGTERM  → graceful cleanup → exit 0 (intentional stop).
 * - uncaughtException → graceful cleanup → exit 1 (Restart=on-failure fires).
 * - Cleanup is BEST-EFFORT and BOUNDED: a throw still exits, and a cleanup
 *   that never settles is force-exited at the deadline with a non-zero code.
 * - A crash during an in-progress shutdown escalates the final code to 1
 *   (it did not shut down cleanly) — the early-return never swallows it.
 * - Repeated signals / repeated exceptions run cleanup ONCE and exit ONCE.
 *
 * All effects (`exit`, timers, `cleanup`, logging) are injected, so the
 * decisions are unit-testable without killing the test runner and without a
 * real clock (AGENTS.md: decision logic pure/injectable, effects at the edge).
 */

import type { Logger } from "@dispatch/kernel";

/** What asked us to shut down. */
export type ShutdownTrigger = "SIGINT" | "SIGTERM" | "uncaughtException";

/**
 * Exit codes. Every crash/timeout code is non-zero so `Restart=on-failure`
 * restarts the process; `clean` is 0 so an intentional `systemctl stop` and a
 * dev Ctrl-C stay down.
 *
 * `deadlineExceeded` is deliberately distinct from `crash`: both restart, but
 * journald / post-mortems can tell "the process threw and cleaned up" from
 * "the process threw and cleanup hung". 70 is sysexits.h's EX_SOFTWARE
 * (internal software error) and is in the non-zero range systemd restarts on.
 */
export const EXIT_CODES = {
  /** Intentional stop completed cleanly (SIGINT/SIGTERM). */
  clean: 0,
  /** A crash (uncaughtException) — cleanup attempted, then exit. */
  crash: 1,
  /** Cleanup did not finish within the deadline — forced exit. */
  deadlineExceeded: 70,
} as const;

/**
 * Shutdown deadline. 10 s is long enough for `host.deactivate()` to dispose
 * extensions and for the collector supervisor to drain, and far below
 * systemd's 90 s default `TimeoutStopSec` (and `DefaultTimeoutStopSec`), so
 * the process always terminates itself before systemd escalates to SIGKILL —
 * and a killed-by-signal process is a restart in any case.
 */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 10_000;

/** Opaque one-shot timer handle returned by the injected `setTimer`. */
export interface ShutdownTimerHandle {
  /** Disarm the timer (no-op if it already fired). */
  readonly cancel: () => void;
}

/** Effects + inputs injected into {@link createShutdownController}. */
export interface ShutdownControllerDeps {
  /**
   * Best-effort cleanup steps (stop telemetry, deactivate the host, drain the
   * collector). Run once; may be sync or async; may throw — a throw is logged
   * and the process still exits with the code for its trigger.
   */
  readonly cleanup: () => void | Promise<void>;
  /**
   * Terminate the process with `code`. Production passes `process.exit`;
   * tests pass a recorder so a unit test never kills the runner.
   */
  readonly exit: (code: number) => void;
  /**
   * Arm a one-shot deadline timer and return its cancel handle. Production
   * passes a plain `setTimeout` (kept ref'd) — the controller only arms it
   * once shutdown has begun, so it can never keep a healthy process alive,
   * and being ref'd guarantees the deadline fires even if a hung cleanup
   * leaves the event loop idle.
   */
  readonly setTimer: (deadlineMs: number, onDeadline: () => void) => ShutdownTimerHandle;
  /** Optional structured logger (crash/shutdown journal lines). */
  readonly logger?: Logger;
  /** Override the deadline (ms). Defaults to {@link DEFAULT_SHUTDOWN_DEADLINE_MS}. */
  readonly deadlineMs?: number;
}

/** The controller handle the composition root wires to process events. */
export interface ShutdownController {
  /**
   * Begin (or join) the shutdown. Safe to call repeatedly and from any
   * trigger: cleanup runs once and `exit` is called exactly once. Never
   * rejects — the promise settles when the process has been told to exit.
   */
  readonly shutdown: (trigger: ShutdownTrigger) => Promise<void>;
  /** True once any shutdown trigger has been observed. */
  readonly isShuttingDown: () => boolean;
}

/**
 * Create the shutdown controller. Pure decision logic over injected effects:
 * no `process`, no timers, no logging implementation of its own.
 */
export function createShutdownController(deps: ShutdownControllerDeps): ShutdownController {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  const logger = deps.logger;

  let started = false;
  /** A crash was observed (at start or later, during an in-progress shutdown). */
  let escalated = false;
  /** `exit` has been called — exactly once, whatever happens after. */
  let finished = false;
  /** The single in-flight cleanup; later triggers join it. */
  let inFlight: Promise<void> | undefined;

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    deps.exit(code);
  };

  const run = async (trigger: ShutdownTrigger): Promise<void> => {
    // Arm the deadline BEFORE cleanup starts so a hang is bounded from the
    // first moment. It is only armed here — never at boot — so it cannot keep
    // a healthy process alive on its own.
    const timer = deps.setTimer(deadlineMs, () => {
      logger?.error("shutdown:deadline-exceeded", {
        trigger,
        deadlineMs,
        code: EXIT_CODES.deadlineExceeded,
      });
      finish(EXIT_CODES.deadlineExceeded);
    });

    try {
      await deps.cleanup();
    } catch (err) {
      // Best-effort: a throwing (or rejecting) cleanup must never prevent the
      // exit. The trigger already decided the code; keep it.
      logger?.error("shutdown:cleanup-failed", { err, trigger });
    } finally {
      // Disarm on every path (a deadline that already fired ignores this).
      timer.cancel();
    }

    // `escalated` is re-read here on purpose: an uncaughtException that
    // arrives while this cleanup is running turns a clean SIGTERM shutdown
    // into a non-zero exit.
    finish(escalated ? EXIT_CODES.crash : EXIT_CODES.clean);
  };

  const shutdown = (trigger: ShutdownTrigger): Promise<void> => {
    if (!started) {
      started = true;
      escalated = trigger === "uncaughtException";
      logger?.info("shutdown:started", {
        trigger,
        deadlineMs,
        code: escalated ? EXIT_CODES.crash : EXIT_CODES.clean,
      });
      inFlight = run(trigger);
      return inFlight;
    }

    // Already shutting down. Repeated signals are no-ops; repeated crashes
    // escalate the code but do NOT restart cleanup or exit twice.
    if (trigger === "uncaughtException" && !escalated) {
      escalated = true;
      logger?.warn("shutdown:escalated", { trigger, code: EXIT_CODES.crash });
    }
    return inFlight ?? Promise.resolve();
  };

  return { shutdown, isShuttingDown: () => started };
}
