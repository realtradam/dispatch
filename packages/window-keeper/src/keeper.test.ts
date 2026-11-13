import { createLogger, type LogLineRecord, type LogRecord } from "@dispatch/kernel";
import type { AccountUsageLimit, AccountUsageReport } from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import {
  BOOT_DELAY_MS,
  CHECK_DELAY_MS,
  DATE_HEADER,
  FALLBACK_KICK_DELAY_MS,
  KICK_BACKOFF_MS,
  MAX_REKICKS,
  MAX_SLEEP_MS,
  REKICK_INTERVAL_MS,
  UNKNOWN_RECHECK_MS,
} from "./core.js";
import { createWindowKeeper, type KickOutcome, type WindowKeeperDeps } from "./keeper.js";
import { CLAUDE_PROFILE, CODEX_PROFILE, type KeeperProfile } from "./profiles.js";

const BASE = 1_760_000_000_000;
const FIVE_HOURS = 5 * 3_600_000;

const CLAUDE_RESET_HEADER = "anthropic-ratelimit-unified-5h-reset";
const CODEX_RESET_AFTER_HEADER = "x-codex-primary-reset-after-seconds";

const secs = (ms: number): string => String(Math.floor(ms / 1000));

function limit(overrides: Partial<AccountUsageLimit> & { id: string }): AccountUsageLimit {
  const { id, ...rest } = overrides;
  return {
    id,
    label: id,
    kind: "window",
    windowId: "5h",
    shared: true,
    tier: null,
    durationMs: null,
    resetsAt: null,
    unit: "percent",
    used: 0,
    limit: 100,
    remaining: 100,
    usedFraction: 0,
    remainingFraction: 1,
    status: "ok",
    ...rest,
  };
}

function reportWith(fetchedAt: number, limits: AccountUsageLimit[]): AccountUsageReport {
  return {
    provider: "claude",
    label: "Claude",
    state: "fresh",
    account: null,
    limits,
    limitReached: null,
    canServe: null,
    creditOverage: false,
    credits: null,
    fetchedAt,
    lastAttemptAt: fetchedAt,
    nextRefreshAt: fetchedAt + 300_000,
    error: null,
  };
}

const idleReport = (now: number): AccountUsageReport =>
  reportWith(now, [limit({ id: "claude:5h" })]);

const runningReport = (now: number, resetsAt: number): AccountUsageReport =>
  reportWith(now, [limit({ id: "claude:5h", resetsAt, usedFraction: 0.2, used: 20 })]);

const blockedReport = (now: number, until: number): AccountUsageReport =>
  reportWith(now, [
    limit({ id: "claude:5h" }),
    limit({ id: "claude:7d", resetsAt: until, status: "exhausted", usedFraction: 1, used: 100 }),
  ]);

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

function createHarness(profile: KeeperProfile = CLAUDE_PROFILE) {
  let nowMs = BASE;
  let timers: Timer[] = [];
  let nextId = 1;
  const records: LogRecord[] = [];
  const kickTimes: number[] = [];
  const stats = { kicks: 0, checks: 0 };
  let reportPlan: (call: number, now: number) => AccountUsageReport | null = (_call, now) =>
    idleReport(now);
  let kickImpl: () => Promise<KickOutcome> = async () => "ok";

  const logger = createLogger(
    { extensionId: "window-keeper-test" },
    { emit: (record) => records.push(record) },
    { now: () => nowMs, newId: () => "test" },
  );

  const deps: WindowKeeperDeps = {
    provider: profile.id,
    limitId: profile.limitId,
    parseReset: profile.parseReset,
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: nowMs + Math.max(0, ms), fn });
      return id;
    },
    clearTimer: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    getReport: async () => {
      stats.checks += 1;
      return reportPlan(stats.checks, nowMs);
    },
    kick: async () => {
      stats.kicks += 1;
      kickTimes.push(nowMs);
      return kickImpl();
    },
    logger,
  };
  const keeper = createWindowKeeper(deps);

  async function flush(): Promise<void> {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  }

  async function advance(ms: number): Promise<void> {
    const target = nowMs + ms;
    for (;;) {
      const due = [...timers]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer.id !== due.id);
      nowMs = due.at;
      due.fn();
      await flush();
    }
    nowMs = Math.max(nowMs, target);
  }

  function nextWakeAt(): number | null {
    if (timers.length === 0) return null;
    return Math.min(...timers.map((timer) => timer.at));
  }

  function logs(): LogLineRecord[] {
    return records.filter((record): record is LogLineRecord => record.kind === "log");
  }

  return {
    keeper,
    stats,
    kickTimes,
    advance,
    flush,
    nextWakeAt,
    logs,
    now: () => nowMs,
    setReportPlan: (fn: (call: number, now: number) => AccountUsageReport | null) => {
      reportPlan = fn;
    },
    setKick: (fn: () => Promise<KickOutcome>) => {
      kickImpl = fn;
    },
  };
}

describe("createWindowKeeper — boot and the running-window sleep", () => {
  it("a running report at boot sends no kick and wakes at reset + 5 s in ≤30-minute hops", async () => {
    const h = createHarness();
    const reset = BASE + FIVE_HOURS;
    h.setReportPlan((_call, now) => runningReport(now, reset));
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);

    expect(h.stats.checks).toBe(1);
    expect(h.stats.kicks).toBe(0);
    expect(h.nextWakeAt()).toBe(BASE + BOOT_DELAY_MS + MAX_SLEEP_MS);

    for (let i = 0; i < 9; i++) await h.advance(MAX_SLEEP_MS);
    expect(h.nextWakeAt()).toBe(reset + CHECK_DELAY_MS);
    expect(h.stats.checks).toBe(1);
    expect(h.stats.kicks).toBe(0);
  });
});

describe("createWindowKeeper — reset, check, kick", () => {
  it("one check after the reset → idle → one kick → starts a window five hours ahead", async () => {
    const h = createHarness();
    const reset = BASE + 60_000;
    h.keeper.start();
    h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(reset) });
    await h.advance(0);
    expect(h.nextWakeAt()).toBe(reset + CHECK_DELAY_MS);

    h.setReportPlan((_call, now) => idleReport(now));
    h.setKick(async () => {
      h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(h.now() + FIVE_HOURS) });
      return "ok";
    });
    await h.advance(reset + CHECK_DELAY_MS - h.now());

    expect(h.stats.checks).toBe(1);
    expect(h.stats.kicks).toBe(1);
    const started = h.logs().find((line) => line.msg === "window-keeper: window started");
    expect(started?.level).toBe("info");
    expect(started?.attributes).toMatchObject({ provider: "claude", attempts: 1 });
    expect(h.nextWakeAt()).toBe(h.now() + MAX_SLEEP_MS);
  });

  it("an unknown check after the reset does no second check and kicks at reset + 30 s", async () => {
    const h = createHarness();
    const reset = BASE + 60_000;
    h.setReportPlan(() => null);
    h.keeper.start();
    h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(reset) });
    await h.advance(reset + CHECK_DELAY_MS - h.now());

    expect(h.stats.checks).toBe(1);
    expect(h.stats.kicks).toBe(0);
    expect(h.nextWakeAt()).toBe(reset + FALLBACK_KICK_DELAY_MS);

    h.setKick(async () => {
      h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(h.now() + FIVE_HOURS) });
      return "ok";
    });
    await h.advance(reset + FALLBACK_KICK_DELAY_MS - h.now());

    expect(h.stats.checks).toBe(1);
    expect(h.stats.kicks).toBe(1);
    expect(h.kickTimes).toEqual([reset + FALLBACK_KICK_DELAY_MS]);
  });

  it("a kick that lands early re-kicks every 15 s and starts on a later attempt", async () => {
    const h = createHarness();
    let kickN = 0;
    h.setKick(async () => {
      kickN += 1;
      const reset = kickN === 1 ? h.now() : h.now() + FIVE_HOURS;
      h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(reset) });
      return "ok";
    });
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);
    expect(h.stats.kicks).toBe(1);

    await h.advance(REKICK_INTERVAL_MS);
    expect(h.stats.kicks).toBe(2);
    expect(h.kickTimes).toEqual([BASE + BOOT_DELAY_MS, BASE + BOOT_DELAY_MS + REKICK_INTERVAL_MS]);
    expect(h.stats.checks).toBe(1);
  });

  it("never starting sends exactly six kicks then backs off 10 minutes and checks (no kick)", async () => {
    const h = createHarness();
    h.setReportPlan((call, now) => (call === 1 ? idleReport(now) : null));
    h.setKick(async () => "ok");
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);

    expect(MAX_REKICKS).toBe(5);
    for (let i = 0; i < MAX_REKICKS; i++) await h.advance(REKICK_INTERVAL_MS);
    expect(h.stats.kicks).toBe(MAX_REKICKS + 1);
    const warn = h.logs().find((line) => line.msg === "window-keeper: could not start a window");
    expect(warn?.level).toBe("warn");
    expect(warn?.attributes).toMatchObject({ provider: "claude", outcome: "ok", attempts: 6 });
    expect(h.nextWakeAt()).toBe(h.now() + KICK_BACKOFF_MS);

    await h.advance(KICK_BACKOFF_MS);
    expect(h.stats.checks).toBe(2);
    expect(h.stats.kicks).toBe(MAX_REKICKS + 1);
    expect(h.nextWakeAt()).toBe(h.now() + UNKNOWN_RECHECK_MS);
  });

  it("an unavailable kick is not retried and backs off 10 minutes", async () => {
    const h = createHarness();
    h.setKick(async () => "unavailable");
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);

    expect(h.stats.kicks).toBe(1);
    const warn = h.logs().find((line) => line.msg === "window-keeper: could not start a window");
    expect(warn?.attributes).toMatchObject({ outcome: "unavailable", attempts: 1 });
    expect(h.nextWakeAt()).toBe(h.now() + KICK_BACKOFF_MS);

    await h.advance(REKICK_INTERVAL_MS);
    expect(h.stats.kicks).toBe(1);
  });
});

describe("createWindowKeeper — unknown and blocked", () => {
  it("unknown reports at boot never kick and re-check every five minutes", async () => {
    const h = createHarness();
    h.setReportPlan(() => null);
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);
    expect(h.stats.kicks).toBe(0);
    expect(h.nextWakeAt()).toBe(h.now() + UNKNOWN_RECHECK_MS);

    await h.advance(UNKNOWN_RECHECK_MS);
    expect(h.stats.checks).toBe(2);
    expect(h.stats.kicks).toBe(0);
    expect(h.nextWakeAt()).toBe(h.now() + UNKNOWN_RECHECK_MS);
  });

  it("a blocked report sends no kick and sleeps to the blocking reset", async () => {
    const h = createHarness();
    const until = BASE + 10 * 60_000;
    h.setReportPlan((_call, now) => blockedReport(now, until));
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);

    expect(h.stats.kicks).toBe(0);
    expect(h.stats.checks).toBe(1);
    expect(h.nextWakeAt()).toBe(until + CHECK_DELAY_MS);
  });

  it("a far-off blocked reset caps the sleep at 30 minutes", async () => {
    const h = createHarness();
    h.setReportPlan((_call, now) => blockedReport(now, now + 3 * 3_600_000));
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);
    expect(h.nextWakeAt()).toBe(h.now() + MAX_SLEEP_MS);
  });
});

describe("createWindowKeeper — header-driven rescheduling", () => {
  it("ordinary traffic headers move resetsAt and reschedule the wake", async () => {
    const h = createHarness();
    h.setReportPlan(() => null);
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);
    const recheck = h.nextWakeAt();
    expect(recheck).toBe(h.now() + UNKNOWN_RECHECK_MS);

    h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(BASE + 2 * 3_600_000) });
    await h.advance(0);
    expect(h.nextWakeAt()).not.toBe(recheck);
    expect(h.nextWakeAt()).toBe(h.now() + MAX_SLEEP_MS);
    expect(h.stats.checks).toBe(1);
  });

  it("a Date header 90 s ahead fires the check 90 s earlier in local time", async () => {
    const h = createHarness();
    const reset = BASE + 600_000;
    h.keeper.start();
    h.keeper.onResponseHeaders({
      [DATE_HEADER]: new Date(BASE + 90_000).toUTCString(),
      [CLAUDE_RESET_HEADER]: secs(reset),
    });
    await h.advance(0);
    expect(h.nextWakeAt()).toBe(reset + CHECK_DELAY_MS - 90_000);
  });

  it("a reset header that is not in the future is ignored", async () => {
    const h = createHarness();
    h.setReportPlan(() => null);
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);
    const wake = h.nextWakeAt();
    h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(BASE) });
    expect(h.nextWakeAt()).toBe(wake);
  });
});

describe("createWindowKeeper — stop and check economy", () => {
  it("stop() cancels the pending timer and aborts an awaiting kick sequence", async () => {
    const h = createHarness();
    let resolveKick: (outcome: KickOutcome) => void = () => {};
    h.setKick(
      () =>
        new Promise<KickOutcome>((resolve) => {
          resolveKick = resolve;
        }),
    );
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);
    expect(h.stats.kicks).toBe(1);

    h.keeper.stop();
    expect(h.nextWakeAt()).toBeNull();
    resolveKick("ok");
    await h.advance(3_600_000);

    expect(h.stats.kicks).toBe(1);
    expect(h.stats.checks).toBe(1);
    expect(h.nextWakeAt()).toBeNull();
  });

  it("stop() before boot prevents any check", async () => {
    const h = createHarness();
    h.keeper.start();
    h.keeper.stop();
    await h.advance(3_600_000);
    expect(h.stats.checks).toBe(0);
    expect(h.stats.kicks).toBe(0);
  });

  it("makes at most one usage check between a reset and the restart", async () => {
    const h = createHarness();
    const reset = BASE + 60_000;
    h.setReportPlan((_call, now) => idleReport(now));
    h.keeper.start();
    h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(reset) });
    await h.advance(0);
    h.setKick(async () => {
      h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(h.now() + FIVE_HOURS) });
      return "ok";
    });

    await h.advance(reset + CHECK_DELAY_MS - h.now());
    expect(h.stats.checks).toBe(1);
    expect(h.stats.kicks).toBe(1);

    await h.advance(60_000);
    expect(h.stats.checks).toBe(1);
  });
});

describe("createWindowKeeper — backoff across failed sequences", () => {
  it("backs off 10 → 20 → 40 minutes and resets the counter after a window starts", async () => {
    const h = createHarness();
    h.setReportPlan((_call, now) => idleReport(now));
    h.setKick(async () => "ok");
    h.keeper.start();

    // Sequence 1: 6 kicks then a 10-minute backoff.
    await h.advance(BOOT_DELAY_MS);
    await h.advance(MAX_REKICKS * REKICK_INTERVAL_MS);
    expect(h.stats.kicks).toBe(MAX_REKICKS + 1);
    expect(h.nextWakeAt()).toBe(h.now() + KICK_BACKOFF_MS);

    // Sequence 2: another 6 kicks then a 20-minute backoff.
    await h.advance(KICK_BACKOFF_MS);
    await h.advance(MAX_REKICKS * REKICK_INTERVAL_MS);
    expect(h.stats.kicks).toBe(2 * (MAX_REKICKS + 1));
    expect(h.nextWakeAt()).toBe(h.now() + 2 * KICK_BACKOFF_MS);

    // Sequence 3: another 6 kicks then a 40-minute backoff.
    await h.advance(2 * KICK_BACKOFF_MS);
    await h.advance(MAX_REKICKS * REKICK_INTERVAL_MS);
    expect(h.stats.kicks).toBe(3 * (MAX_REKICKS + 1));
    expect(h.nextWakeAt()).toBe(h.now() + 4 * KICK_BACKOFF_MS);

    // Sequence 4 starts a window: the failure counter resets.
    h.setKick(async () => {
      h.keeper.onResponseHeaders({ [CLAUDE_RESET_HEADER]: secs(h.now() + FIVE_HOURS) });
      return "ok";
    });
    await h.advance(4 * KICK_BACKOFF_MS);
    expect(h.logs().some((line) => line.msg === "window-keeper: window started")).toBe(true);

    // Let that window run out, then fail once more: a fresh 10-minute backoff.
    h.setKick(async () => "ok");
    await h.advance(FIVE_HOURS + CHECK_DELAY_MS);
    await h.advance(MAX_REKICKS * REKICK_INTERVAL_MS);
    expect(h.nextWakeAt()).toBe(h.now() + KICK_BACKOFF_MS);
  });
});

describe("createWindowKeeper — lifecycle idempotence and restart", () => {
  it("stop() then start() resumes cleanly; a pre-stop continuation does nothing", async () => {
    const h = createHarness();
    let resolveKick: (outcome: KickOutcome) => void = () => {};
    h.setKick(
      () =>
        new Promise<KickOutcome>((resolve) => {
          resolveKick = resolve;
        }),
    );
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);
    expect(h.stats.kicks).toBe(1);

    h.keeper.stop();
    h.keeper.start();
    const restartAt = h.now();
    expect(h.nextWakeAt()).toBe(restartAt + BOOT_DELAY_MS);

    // The continuation created before stop() resolves, but must be inert.
    resolveKick("ok");
    await h.flush();
    expect(h.stats.kicks).toBe(1);
    expect(h.nextWakeAt()).toBe(restartAt + BOOT_DELAY_MS);

    // The restarted loop checks after BOOT_DELAY_MS and kicks again.
    await h.advance(BOOT_DELAY_MS);
    expect(h.stats.checks).toBe(2);
    expect(h.stats.kicks).toBe(2);
  });

  it("start() twice and stop() twice are no-ops", async () => {
    const h = createHarness();
    h.setReportPlan(() => null);
    h.keeper.start();
    const wake = h.nextWakeAt();
    expect(wake).toBe(BASE + BOOT_DELAY_MS);

    h.keeper.start();
    expect(h.nextWakeAt()).toBe(wake);

    await h.advance(BOOT_DELAY_MS);
    expect(h.stats.checks).toBe(1);

    h.keeper.stop();
    expect(h.nextWakeAt()).toBeNull();
    h.keeper.stop();
    expect(h.nextWakeAt()).toBeNull();

    await h.advance(3_600_000);
    expect(h.stats.checks).toBe(1);
    expect(h.stats.kicks).toBe(0);
  });
});

describe("createWindowKeeper — Codex profile", () => {
  it("a Codex-shaped run: floating-idle → one kick → reset-after header → running until that reset", async () => {
    const h = createHarness(CODEX_PROFILE);
    const resetAfterSeconds = 600;
    h.setReportPlan((_call, now) =>
      reportWith(now, [limit({ id: "codex:primary", usedFraction: 0 })]),
    );
    h.setKick(async () => {
      h.keeper.onResponseHeaders({
        [CODEX_RESET_AFTER_HEADER]: String(resetAfterSeconds),
      });
      return "ok";
    });
    h.keeper.start();
    await h.advance(BOOT_DELAY_MS);

    expect(h.stats.checks).toBe(1);
    expect(h.stats.kicks).toBe(1);
    const started = h.logs().find((line) => line.msg === "window-keeper: window started");
    expect(started?.attributes).toMatchObject({ provider: "codex", attempts: 1 });

    const kickAt = BASE + BOOT_DELAY_MS;
    const reset = kickAt + resetAfterSeconds * 1000;
    expect(h.nextWakeAt()).toBe(reset + CHECK_DELAY_MS);
  });
});
