import { describe, expect, it } from "vitest";
import { type ConcurrencyService, createConcurrencyManager } from "./concurrency-manager.js";

// ─── Fake timers ──────────────────────────────────────────────────────────────

interface FakeTimer {
  fire: () => void;
  cleared: boolean;
}

function createFakeTimers() {
  let currentTime = 0;
  const intervals: FakeTimer[] = [];
  const timeouts: { time: number; fire: () => void; cleared: boolean }[] = [];

  const setInterval = ((_fn: () => void, _ms: number) => {
    const timer: FakeTimer = { fire: () => _fn(), cleared: false };
    intervals.push(timer);
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  const clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    const t = timer as unknown as FakeTimer;
    t.cleared = true;
  }) as typeof clearInterval;

  const setTimeout = ((_fn: () => void, ms: number) => {
    const entry = { time: currentTime + ms, fire: () => _fn(), cleared: false };
    timeouts.push(entry);
    return entry as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    const t = timer as unknown as { cleared: boolean };
    t.cleared = true;
  }) as typeof clearTimeout;

  return {
    now: () => currentTime,
    advance(ms: number) {
      currentTime += ms;
      // Fire any due timeouts.
      for (const entry of timeouts) {
        if (!entry.cleared && entry.time <= currentTime) {
          entry.cleared = true;
          entry.fire();
        }
      }
    },
    fireIntervals() {
      for (const timer of intervals) {
        if (!timer.cleared) timer.fire();
      }
    },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  };
}

function createManager(opts?: { releaseCooldownMs?: number }): {
  manager: ConcurrencyService;
  timers: ReturnType<typeof createFakeTimers>;
} {
  const timers = createFakeTimers();
  const manager = createConcurrencyManager({
    now: timers.now,
    slotTimeoutMs: 5000,
    watchdogIntervalMs: 1000,
    defaultPauseMs: 30000,
    ...(opts?.releaseCooldownMs !== undefined ? { releaseCooldownMs: opts.releaseCooldownMs } : {}),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  return { manager, timers };
}

describe("createConcurrencyManager", () => {
  it("returns no-op release for providers with no configured limit", async () => {
    const { manager } = createManager();
    const release = await manager.acquire("unknown", "conv1", 0);
    expect(typeof release).toBe("function");
    // No state → release is a no-op, no error.
    release();
    expect(manager.getStatus("unknown")).toBeUndefined();
  });

  it("grants immediately when under the limit", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 4);

    const release1 = await manager.acquire("umans", "conv1", 0);
    const status = manager.getStatus("umans");
    expect(status).toEqual({
      providerId: "umans",
      limit: 4,
      inFlight: 1,
      queued: 0,
      paused: false,
    });
    release1();
    expect(manager.getStatus("umans")?.inFlight).toBe(0);
  });

  it("queues when at the limit and grants on release (FIFO when same priority)", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 1);

    const release1 = await manager.acquire("umans", "conv1", 100);

    // Second request should block (at limit).
    let resolved = false;
    const promise2 = manager.acquire("umans", "conv2", 200).then((r) => {
      resolved = true;
      return r;
    });

    // Let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(manager.getStatus("umans")?.queued).toBe(1);

    // Release the first slot.
    release1();

    const release2 = await promise2;
    expect(resolved).toBe(true);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);
    expect(manager.getStatus("umans")?.queued).toBe(0);
    release2();
  });

  it("grants to the oldest agent first (priority queue by promptStartedAt)", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 1);

    // Hold the single slot.
    const release0 = await manager.acquire("umans", "holder", 0);

    // Three agents queue with different prompt start times.
    // Agent C started latest (t=300), Agent A started earliest (t=100).
    const results: string[] = [];
    const acquireAndRecord = (conv: string, promptAt: number) =>
      manager.acquire("umans", conv, promptAt).then((r) => {
        results.push(conv);
        return r;
      });

    // Queue in non-sorted order: B (t=200), A (t=100), C (t=300).
    const pB = acquireAndRecord("convB", 200);
    const pA = acquireAndRecord("convA", 100);
    const pC = acquireAndRecord("convC", 300);

    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([]); // none resolved yet.

    // Release the holder. The oldest agent (A, t=100) should get the slot first.
    release0();

    const rA = await pA;
    expect(results).toEqual(["convA"]);

    rA.release ? rA.release() : rA();

    // Now B (t=200) should be next.
    const rB = await pB;
    expect(results).toEqual(["convA", "convB"]);
    rB.release ? rB.release() : rB();

    // Then C (t=300).
    const rC = await pC;
    expect(results).toEqual(["convA", "convB", "convC"]);
    rC.release ? rC.release() : rC();
  });

  it("does not grant slots while paused (429 backoff)", async () => {
    const { manager, timers } = createManager();
    manager.setLimit("umans", 1);

    const release1 = await manager.acquire("umans", "conv1", 0);
    release1();

    // Simulate a 429 → queue pauses.
    manager.reportRateLimit("umans");
    const status = manager.getStatus("umans");
    expect(status?.paused).toBe(true);
    expect(status?.pausedUntil).toBe(30000);

    // A new acquire should block (paused, even though under limit).
    let resolved = false;
    const promise = manager.acquire("umans", "conv2", 0).then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Advance past the pause duration.
    timers.advance(30000);

    const release2 = await promise;
    expect(resolved).toBe(true);
    expect(manager.getStatus("umans")?.paused).toBe(false);
    release2();
  });

  it("respects retryAfterMs for 429 backoff", () => {
    const { manager } = createManager();
    manager.setLimit("umans", 2);

    manager.reportRateLimit("umans", 5000);
    expect(manager.getStatus("umans")?.pausedUntil).toBe(5000);
  });

  it("watchdog reclaims slots held beyond the timeout", async () => {
    const { manager, timers } = createManager();
    manager.setLimit("umans", 1);

    const release = await manager.acquire("umans", "conv1", 0);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);

    // Advance past the slot timeout (5000ms) and fire the watchdog.
    timers.advance(5001);
    timers.fireIntervals();

    // The watchdog should have force-released the slot.
    expect(manager.getStatus("umans")?.inFlight).toBe(0);

    // Calling release again (from the holder) should be a no-op (idempotent).
    release();
    expect(manager.getStatus("umans")?.inFlight).toBe(0);
  });

  it("watchdog grants the next waiter after reclaiming a stale slot", async () => {
    const { manager, timers } = createManager();
    manager.setLimit("umans", 1);

    // Hold the slot.
    await manager.acquire("umans", "holder", 0);

    // Queue a waiter.
    let resolved = false;
    const promise = manager.acquire("umans", "waiter", 10).then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Watchdog reclaims the held slot.
    timers.advance(5001);
    timers.fireIntervals();

    // The waiter should now be granted.
    const release = await promise;
    expect(resolved).toBe(true);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);
    release();
  });

  it("setLimit grants queued requests when the limit increases", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 1);

    const release1 = await manager.acquire("umans", "conv1", 0);

    // Queue a waiter.
    let resolved = false;
    const promise = manager.acquire("umans", "conv2", 100).then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Increase the limit → the queued request should be granted.
    manager.setLimit("umans", 2);

    const release2 = await promise;
    expect(resolved).toBe(true);
    expect(manager.getStatus("umans")?.inFlight).toBe(2);

    release2();
    release1();
  });

  it("removeLimit grants all queued requests and removes the state", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 1);

    const release1 = await manager.acquire("umans", "conv1", 0);

    // Queue two waiters.
    const p2 = manager.acquire("umans", "conv2", 100);
    const p3 = manager.acquire("umans", "conv3", 200);
    await Promise.resolve();
    await Promise.resolve();

    // Remove the limit → all queued requests should be granted.
    manager.removeLimit("umans");

    const r2 = await p2;
    const r3 = await p3;
    expect(manager.getStatus("umans")).toBeUndefined();

    // Releases work (no error after state removal).
    r2();
    r3();
    release1();
  });

  it("getLimits returns all configured limits", () => {
    const { manager } = createManager();
    manager.setLimit("umans", 4);
    manager.setLimit("openai-compat", 5);

    const limits = manager.getLimits();
    expect(limits).toHaveLength(2);
    expect(limits).toContainEqual({ providerId: "umans", limit: 4 });
    expect(limits).toContainEqual({ providerId: "openai-compat", limit: 5 });
  });

  it("getStatusAll returns status for all configured providers", () => {
    const { manager } = createManager();
    manager.setLimit("umans", 4);
    manager.setLimit("anthropic", 3);

    const statuses = manager.getStatusAll();
    expect(statuses).toHaveLength(2);
    const umans = statuses.find((s) => s.providerId === "umans");
    expect(umans).toEqual({
      providerId: "umans",
      limit: 4,
      inFlight: 0,
      queued: 0,
      paused: false,
    });
  });

  it("destroy clears timers without error", () => {
    const { manager } = createManager();
    manager.setLimit("umans", 4);
    manager.reportRateLimit("umans", 5000);
    expect(() => manager.destroy()).not.toThrow();
  });

  it("release is idempotent (double-release does not overshoot)", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 2);

    const release = await manager.acquire("umans", "conv1", 0);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);

    release();
    expect(manager.getStatus("umans")?.inFlight).toBe(0);

    // Double-release should not decrement below 0.
    release();
    expect(manager.getStatus("umans")?.inFlight).toBe(0);
  });

  it("multiple concurrent acquires up to the limit all resolve immediately", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 3);

    const releases = await Promise.all([
      manager.acquire("umans", "conv1", 0),
      manager.acquire("umans", "conv2", 0),
      manager.acquire("umans", "conv3", 0),
    ]);

    expect(manager.getStatus("umans")?.inFlight).toBe(3);

    for (const release of releases) {
      release();
    }
    expect(manager.getStatus("umans")?.inFlight).toBe(0);
  });

  it("release cooldown delays slot recycling (inFlight stays incremented during cooldown)", async () => {
    const { manager, timers } = createManager({ releaseCooldownMs: 200 });
    manager.setLimit("umans", 1);

    const release1 = await manager.acquire("umans", "conv1", 0);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);

    // Queue a waiter.
    let resolved = false;
    const promise2 = manager.acquire("umans", "conv2", 100).then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(manager.getStatus("umans")?.queued).toBe(1);

    // Release the slot — inFlight should stay 1 (cooldown active).
    release1();
    expect(manager.getStatus("umans")?.inFlight).toBe(1);
    expect(resolved).toBe(false); // waiter NOT granted yet

    // Advance past the cooldown.
    timers.advance(200);

    // Now the slot is recycled and the waiter is granted.
    const release2 = await promise2;
    expect(resolved).toBe(true);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);
    expect(manager.getStatus("umans")?.queued).toBe(0);
    release2();
  });

  it("release cooldown is idempotent (double-release only schedules one cooldown)", async () => {
    const { manager, timers } = createManager({ releaseCooldownMs: 200 });
    manager.setLimit("umans", 2);

    const release = await manager.acquire("umans", "conv1", 0);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);

    release();
    expect(manager.getStatus("umans")?.inFlight).toBe(1); // still 1 (cooldown)

    // Double-release should not schedule a second cooldown.
    release();

    // After cooldown, inFlight should drop by exactly 1 (to 0), not 2.
    timers.advance(200);
    expect(manager.getStatus("umans")?.inFlight).toBe(0);
  });

  it("destroy clears cooldown timers without error", () => {
    const { manager } = createManager({ releaseCooldownMs: 200 });
    manager.setLimit("umans", 1);
    // Acquire + release to schedule a cooldown timer.
    manager.acquire("umans", "conv1", 0).then((release) => {
      release();
      // Now there's a pending cooldown timer — destroy should clean it up.
      expect(() => manager.destroy()).not.toThrow();
    });
  });
});
