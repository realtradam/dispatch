import { describe, expect, it } from "vitest";
import { HeartbeatScheduler, type Timers } from "./scheduler.js";

interface FakeTimer {
  readonly fn: () => void;
  readonly firesAt: number;
}

/**
 * A controllable fake clock: `advance(ms)` moves virtual time forward and runs
 * any timers that became due. The injected `fire` returns a deferred the test
 * resolves manually, so we can assert the "running" state and the re-arm that
 * happens only AFTER the run completes.
 */
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();
  const timersApi: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, firesAt: now + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      if (handle !== undefined) timers.delete(handle as unknown as number);
    },
  };
  return {
    timers: timersApi,
    advance(ms: number): number {
      now += ms;
      let fired = 0;
      const due = [...timers.entries()]
        .filter(([, t]) => t.firesAt <= now)
        .sort((a, b) => a[0] - b[0]);
      for (const [id, t] of due) {
        timers.delete(id);
        t.fn();
        fired++;
      }
      return fired;
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}

/** A deferred promise the test resolves to signal run completion. */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Flush pending microtasks (the scheduler's .finally re-arm runs as a microtask
// after the fire promise resolves).
const flush = async (): Promise<void> => {
  await new Promise((r) => queueMicrotask(r));
};

describe("HeartbeatScheduler", () => {
  it("arms a timer that fires after intervalMinutes", () => {
    const fake = createFakeTimers();
    const fires: string[] = [];
    const deferreds: Array<{ resolve: () => void }> = [];
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: (ws) => {
        fires.push(ws);
        const d = createDeferred();
        deferreds.push(d);
        return d.promise;
      },
    });

    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    expect(scheduler.isArmed("ws-1")).toBe(true);
    expect(fake.pendingCount()).toBe(1);

    // Just shy of the interval → no fire.
    expect(fake.advance(59_999)).toBe(0);
    expect(fires).toEqual([]);

    // Exactly the interval (1 minute = 60_000ms) → fires.
    expect(fake.advance(1)).toBe(1);
    expect(fires).toEqual(["ws-1"]);
    // While the run is in progress: running, no pending timer.
    expect(scheduler.isRunning("ws-1")).toBe(true);
    expect(fake.pendingCount()).toBe(0);
  });

  it("re-arms only after the run completes (reset timer after each run)", async () => {
    const fake = createFakeTimers();
    const fires: string[] = [];
    const deferreds: Array<{ resolve: () => void }> = [];
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: (ws) => {
        fires.push(ws);
        const d = createDeferred();
        deferreds.push(d);
        return d.promise;
      },
    });

    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    fake.advance(60_000); // first fire
    expect(fires).toEqual(["ws-1"]);
    // Run in progress — no new timer yet.
    expect(fake.pendingCount()).toBe(0);

    // Completing the run schedules the next fire.
    deferreds[0]?.resolve();
    await flush();
    expect(scheduler.isRunning("ws-1")).toBe(false);
    expect(fake.pendingCount()).toBe(1);

    // Next fire after another interval.
    fake.advance(60_000);
    expect(fires).toEqual(["ws-1", "ws-1"]);
  });

  it("uses a longer interval for a higher intervalMinutes", () => {
    const fake = createFakeTimers();
    let fireCount = 0;
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => {
        fireCount++;
        return createDeferred().promise;
      },
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 30 });
    // 1 minute wouldn't fire a 30-minute schedule.
    expect(fake.advance(60_000)).toBe(0);
    // 28 more minutes (29 total) still wouldn't fire.
    expect(fake.advance(28 * 60_000)).toBe(0);
    // The remaining minute completes the 30 minutes → fires.
    expect(fake.advance(60_000)).toBe(1);
    expect(fireCount).toBe(1);
  });

  it("disarms (clears the pending timer) when disabled", () => {
    const fake = createFakeTimers();
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => createDeferred().promise,
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    expect(fake.pendingCount()).toBe(1);
    scheduler.arm("ws-1", { enabled: false, intervalMinutes: 1 });
    expect(scheduler.isArmed("ws-1")).toBe(false);
    expect(fake.pendingCount()).toBe(0);
  });

  it("disarmAll stops every schedule", () => {
    const fake = createFakeTimers();
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => createDeferred().promise,
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    scheduler.arm("ws-2", { enabled: true, intervalMinutes: 1 });
    expect(fake.pendingCount()).toBe(2);
    scheduler.disarmAll();
    expect(fake.pendingCount()).toBe(0);
    expect(scheduler.isArmed("ws-1")).toBe(false);
    expect(scheduler.isArmed("ws-2")).toBe(false);
  });

  it("does not re-arm after a disarm during a run", async () => {
    const fake = createFakeTimers();
    const deferreds: Array<{ resolve: () => void }> = [];
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => {
        const d = createDeferred();
        deferreds.push(d);
        return d.promise;
      },
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    fake.advance(60_000); // fire in progress
    scheduler.disarm("ws-1"); // disarm mid-run
    deferreds[0]?.resolve();
    await flush();
    // Disarmed → no re-arm scheduled.
    expect(fake.pendingCount()).toBe(0);
    expect(scheduler.isArmed("ws-1")).toBe(false);
  });

  it("a config update during a run applies the new interval on the next re-arm", async () => {
    const fake = createFakeTimers();
    const deferreds: Array<{ resolve: () => void }> = [];
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => {
        const d = createDeferred();
        deferreds.push(d);
        return d.promise;
      },
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    fake.advance(60_000); // first fire (interval=1m)
    // Update interval to 5m while the run is in progress.
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 5 });
    expect(scheduler.isRunning("ws-1")).toBe(true);
    expect(fake.pendingCount()).toBe(0); // no new timer while running
    deferreds[0]?.resolve();
    await flush();
    // Re-armed with the NEW 5-minute interval.
    expect(fake.advance(60_000)).toBe(0); // 1 minute isn't enough now
    expect(fake.advance(4 * 60_000)).toBe(1); // completes 5 minutes → fires
  });

  it("a thrown fire is swallowed and the loop continues", async () => {
    const fake = createFakeTimers();
    let fireCount = 0;
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => {
        fireCount++;
        return Promise.reject(new Error("boom"));
      },
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    fake.advance(60_000);
    await flush();
    expect(fireCount).toBe(1);
    // Loop continues: next fire scheduled.
    expect(fake.pendingCount()).toBe(1);
    fake.advance(60_000);
    expect(fireCount).toBe(2);
  });

  // ─── nextFireAt (CR-HB-3: server-authoritative next-run time) ──────────────

  it("nextFireAt returns null for a workspace with no schedule", () => {
    const fake = createFakeTimers();
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => createDeferred().promise,
    });
    expect(scheduler.nextFireAt("unknown")).toBeNull();
  });

  it("nextFireAt returns the absolute fire time when armed (now + intervalMs)", () => {
    const fake = createFakeTimers();
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => createDeferred().promise,
    });
    // now=0, interval=1m → next fire at epoch-ms 60_000.
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    expect(scheduler.nextFireAt("ws-1")).toBe(60_000);
  });

  it("nextFireAt reflects a longer interval", () => {
    const fake = createFakeTimers();
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => createDeferred().promise,
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 30 });
    expect(scheduler.nextFireAt("ws-1")).toBe(30 * 60_000);
  });

  it("nextFireAt reflects a new interval on re-arm (not running)", () => {
    const fake = createFakeTimers();
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => createDeferred().promise,
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    expect(scheduler.nextFireAt("ws-1")).toBe(60_000);
    // Re-arm with a 5-minute interval (armed, not running) → recomputed.
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 5 });
    expect(scheduler.nextFireAt("ws-1")).toBe(5 * 60_000);
  });

  it("nextFireAt returns null when disarmed", () => {
    const fake = createFakeTimers();
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => createDeferred().promise,
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    expect(scheduler.nextFireAt("ws-1")).toBe(60_000);
    scheduler.disarm("ws-1");
    expect(scheduler.nextFireAt("ws-1")).toBeNull();
  });

  it("nextFireAt returns null while a run is in progress, then the next fire after it completes", async () => {
    const fake = createFakeTimers();
    const deferreds: Array<{ resolve: () => void }> = [];
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => {
        const d = createDeferred();
        deferreds.push(d);
        return d.promise;
      },
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    expect(scheduler.nextFireAt("ws-1")).toBe(60_000);

    fake.advance(60_000); // fire → run in progress
    expect(scheduler.isRunning("ws-1")).toBe(true);
    // In flight → no next run queued yet.
    expect(scheduler.nextFireAt("ws-1")).toBeNull();

    deferreds[0]?.resolve();
    await flush();
    // Re-armed at completion-time (60_000) + interval (60_000) = 120_000.
    expect(scheduler.nextFireAt("ws-1")).toBe(120_000);
  });

  it("nextFireAt returns null after disarming mid-run (no re-arm)", async () => {
    const fake = createFakeTimers();
    const deferreds: Array<{ resolve: () => void }> = [];
    const scheduler = new HeartbeatScheduler({
      timers: fake.timers,
      fire: () => {
        const d = createDeferred();
        deferreds.push(d);
        return d.promise;
      },
    });
    scheduler.arm("ws-1", { enabled: true, intervalMinutes: 1 });
    fake.advance(60_000); // fire in progress
    expect(scheduler.nextFireAt("ws-1")).toBeNull(); // running
    scheduler.disarm("ws-1"); // disarm mid-run
    deferreds[0]?.resolve();
    await flush();
    // Disarmed → no re-arm, no fire time.
    expect(scheduler.nextFireAt("ws-1")).toBeNull();
  });
});
