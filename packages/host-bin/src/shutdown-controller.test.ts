/**
 * Unit tests for the shutdown controller — the exit-code decision logic.
 *
 * Every effect is a fake (exit, timers, cleanup, logger), so nothing here can
 * kill the test runner or wait on a real clock (AGENTS.md: pure core, zero
 * internal mocks — the real module runs, only its injected edge effects are
 * fakes).
 */

import type { Logger } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  createShutdownController,
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  EXIT_CODES,
  type ShutdownController,
} from "./shutdown-controller.js";

interface DeadlineRecord {
  readonly ms: number;
  readonly fire: () => void;
  cancelled: boolean;
}

interface LogRecord {
  readonly level: string;
  readonly msg: string;
}

interface Harness {
  readonly controller: ShutdownController;
  readonly cleanupCalls: () => number;
  readonly exits: number[];
  readonly deadlines: DeadlineRecord[];
  readonly logs: LogRecord[];
}

function makeLogger(logs: LogRecord[]): Logger {
  const record = (level: string) => (msg: string) => {
    logs.push({ level, msg });
  };
  const logger: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger,
    span: () => {
      throw new Error("not used");
    },
  };
  return logger;
}

function harness(
  opts: { cleanup?: () => void | Promise<void>; deadlineMs?: number } = {},
): Harness {
  let cleanupCalls = 0;
  const exits: number[] = [];
  const deadlines: DeadlineRecord[] = [];
  const logs: LogRecord[] = [];

  const controller = createShutdownController({
    cleanup: () => {
      cleanupCalls++;
      return opts.cleanup?.();
    },
    exit: (code) => {
      exits.push(code);
    },
    setTimer: (ms, onDeadline) => {
      const record: DeadlineRecord = { ms, fire: onDeadline, cancelled: false };
      deadlines.push(record);
      return {
        cancel: () => {
          record.cancelled = true;
        },
      };
    },
    logger: makeLogger(logs),
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
  });

  return {
    controller,
    cleanupCalls: () => cleanupCalls,
    exits,
    deadlines,
    logs,
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending microtasks so the in-flight cleanup can settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("createShutdownController — exit codes per trigger", () => {
  it("SIGTERM: runs cleanup once, then exits 0 (intentional stop)", async () => {
    const h = harness();
    await h.controller.shutdown("SIGTERM");

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([EXIT_CODES.clean]);
    expect(EXIT_CODES.clean).toBe(0);
  });

  it("SIGINT: runs cleanup once, then exits 0 (dev Ctrl-C)", async () => {
    const h = harness();
    await h.controller.shutdown("SIGINT");

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([EXIT_CODES.clean]);
  });

  it("uncaughtException: runs cleanup, then exits NON-ZERO so systemd restarts", async () => {
    const h = harness();
    await h.controller.shutdown("uncaughtException");

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]).toBe(EXIT_CODES.crash);
    expect(h.exits[0]).not.toBe(0);
  });

  it("awaits an async cleanup before exiting", async () => {
    const gate = deferred();
    const h = harness({ cleanup: () => gate.promise });

    const done = h.controller.shutdown("SIGTERM");
    await flush();
    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([]); // cleanup still in flight

    gate.resolve();
    await done;
    expect(h.exits).toEqual([EXIT_CODES.clean]);
  });

  it("logs the trigger, deadline and decided code when shutdown starts", async () => {
    const h = harness({ deadlineMs: 1234 });
    await h.controller.shutdown("uncaughtException");

    expect(h.logs.map((l) => l.msg)).toContain("shutdown:started");
  });
});

describe("createShutdownController — throwing cleanup is best-effort", () => {
  it("exits per trigger when cleanup throws synchronously (SIGTERM → 0)", async () => {
    const h = harness({
      cleanup: () => {
        throw new Error("deactivate blew up");
      },
    });
    await h.controller.shutdown("SIGTERM");

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([EXIT_CODES.clean]);
    expect(h.logs.map((l) => l.msg)).toContain("shutdown:cleanup-failed");
  });

  it("exits per trigger when cleanup throws synchronously (crash → non-zero)", async () => {
    const h = harness({
      cleanup: () => {
        throw new Error("deactivate blew up");
      },
    });
    await h.controller.shutdown("uncaughtException");

    expect(h.exits).toEqual([EXIT_CODES.crash]);
    expect(h.exits[0]).not.toBe(0);
  });

  it("exits per trigger when cleanup rejects asynchronously", async () => {
    const gate = deferred();
    const h = harness({ cleanup: () => gate.promise });

    const done = h.controller.shutdown("uncaughtException");
    gate.reject(new Error("drain failed"));
    await done;

    expect(h.exits).toEqual([EXIT_CODES.crash]);
    expect(h.logs.map((l) => l.msg)).toContain("shutdown:cleanup-failed");
  });
});

describe("createShutdownController — bounded cleanup", () => {
  it("force-exits with a non-zero code when cleanup never settles", async () => {
    const h = harness({ cleanup: () => new Promise<void>(() => {}) });
    void h.controller.shutdown("SIGTERM");
    await flush();

    expect(h.exits).toEqual([]);
    expect(h.deadlines).toHaveLength(1);
    const deadline = h.deadlines[0] as DeadlineRecord;
    expect(deadline.ms).toBe(DEFAULT_SHUTDOWN_DEADLINE_MS);

    deadline.fire();

    expect(h.exits).toEqual([EXIT_CODES.deadlineExceeded]);
    expect(h.exits[0]).not.toBe(0); // a hung shutdown is a failure, not a clean stop
  });

  it("force-exits a hung crash cleanup with a non-zero code", async () => {
    const h = harness({ cleanup: () => new Promise<void>(() => {}) });
    void h.controller.shutdown("uncaughtException");
    await flush();

    (h.deadlines[0] as DeadlineRecord).fire();

    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]).not.toBe(0);
  });

  it("exits exactly once if cleanup settles after the deadline fired", async () => {
    const gate = deferred();
    const h = harness({ cleanup: () => gate.promise });
    const done = h.controller.shutdown("SIGTERM");
    await flush();

    (h.deadlines[0] as DeadlineRecord).fire();
    gate.resolve();
    await done;

    expect(h.exits).toEqual([EXIT_CODES.deadlineExceeded]);
    expect(h.logs.map((l) => l.msg)).toContain("shutdown:deadline-exceeded");
  });

  it("does not arm a deadline until shutdown starts (never keeps a healthy process alive)", () => {
    const h = harness();
    expect(h.deadlines).toHaveLength(0);
    expect(h.controller.isShuttingDown()).toBe(false);
  });

  it("cancels the deadline timer after a clean completion", async () => {
    const h = harness();
    await h.controller.shutdown("SIGTERM");

    expect(h.deadlines).toHaveLength(1);
    expect((h.deadlines[0] as DeadlineRecord).cancelled).toBe(true);
  });

  it("uses the configured deadline override", async () => {
    const h = harness({ deadlineMs: 42, cleanup: () => new Promise<void>(() => {}) });
    void h.controller.shutdown("SIGTERM");
    await flush();

    expect((h.deadlines[0] as DeadlineRecord).ms).toBe(42);
  });

  it("keeps the default deadline well under systemd's 90s stop timeout", () => {
    expect(DEFAULT_SHUTDOWN_DEADLINE_MS).toBe(10_000);
    expect(DEFAULT_SHUTDOWN_DEADLINE_MS).toBeLessThan(90_000);
  });
});

describe("createShutdownController — crash during an in-progress shutdown", () => {
  it("escalates a SIGTERM shutdown to a non-zero exit when a crash arrives mid-cleanup", async () => {
    const gate = deferred();
    const h = harness({ cleanup: () => gate.promise });

    const sigterm = h.controller.shutdown("SIGTERM");
    await flush();
    expect(h.controller.isShuttingDown()).toBe(true);

    const crash = h.controller.shutdown("uncaughtException");
    gate.resolve();
    await Promise.all([sigterm, crash]);

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([EXIT_CODES.crash]);
    expect(h.exits[0]).not.toBe(0);
  });

  it("escalates even when the escalation lands after cleanup settled but before exit", async () => {
    // Cleanup resolves immediately; the crash trigger arrives in the same
    // microtask window, before `finish()` runs.
    const h = harness();
    const first = h.controller.shutdown("SIGTERM");
    const crash = h.controller.shutdown("uncaughtException");
    await Promise.all([first, crash]);

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([EXIT_CODES.crash]);
    expect(h.logs.map((l) => l.msg)).toContain("shutdown:escalated");
  });

  it("a second uncaughtException during a throwing crash cleanup still exits once, non-zero", async () => {
    const gate = deferred();
    const h = harness({ cleanup: () => gate.promise });

    const first = h.controller.shutdown("uncaughtException");
    await flush();
    const second = h.controller.shutdown("uncaughtException");
    gate.reject(new Error("cleanup died too"));
    await Promise.all([first, second]);

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([EXIT_CODES.crash]);
  });
});

describe("createShutdownController — idempotence", () => {
  it("repeated signals run cleanup once and exit exactly once", async () => {
    const gate = deferred();
    const h = harness({ cleanup: () => gate.promise });

    const a = h.controller.shutdown("SIGTERM");
    const b = h.controller.shutdown("SIGTERM");
    const c = h.controller.shutdown("SIGINT");
    gate.resolve();
    await Promise.all([a, b, c]);

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([EXIT_CODES.clean]);
    expect(h.deadlines).toHaveLength(1);
  });

  it("repeated exceptions run cleanup once and exit exactly once", async () => {
    const gate = deferred();
    const h = harness({ cleanup: () => gate.promise });

    const a = h.controller.shutdown("uncaughtException");
    const b = h.controller.shutdown("uncaughtException");
    const c = h.controller.shutdown("uncaughtException");
    gate.resolve();
    await Promise.all([a, b, c]);

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([EXIT_CODES.crash]);
  });

  it("a signal after a completed crash shutdown does not exit twice", async () => {
    const h = harness();
    await h.controller.shutdown("uncaughtException");
    await h.controller.shutdown("SIGTERM");

    expect(h.cleanupCalls()).toBe(1);
    expect(h.exits).toEqual([EXIT_CODES.crash]);
  });
});

describe("EXIT_CODES", () => {
  it("every abnormal scenario is non-zero and distinct from a clean stop", () => {
    expect(EXIT_CODES.clean).toBe(0);
    expect(EXIT_CODES.crash).toBeGreaterThan(0);
    expect(EXIT_CODES.deadlineExceeded).toBeGreaterThan(0);
    expect(EXIT_CODES.deadlineExceeded).not.toBe(EXIT_CODES.crash);
  });
});
