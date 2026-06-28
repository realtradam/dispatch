import type { ProviderUsage } from "@dispatch/kernel";
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

function createManager(opts?: {
  releaseCooldownMs?: number;
  fetchUsage?: (providerId: string) => Promise<ProviderUsage | undefined>;
  onLimitReduced?: (providerId: string, newLimit: number, oldLimit: number) => void;
}): {
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
    ...(opts?.fetchUsage !== undefined ? { fetchUsage: opts.fetchUsage } : {}),
    ...(opts?.onLimitReduced !== undefined ? { onLimitReduced: opts.onLimitReduced } : {}),
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
      cooldownMs: 0,
      autoReduced: false,
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
      cooldownMs: 0,
      autoReduced: false,
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

  it("onQueued is called when the request is enqueued (not granted immediately)", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 1);

    // Hold the single slot.
    const release1 = await manager.acquire("umans", "conv1", 0);

    // Second request should trigger onQueued.
    let queuedCalled = false;
    const promise = manager.acquire("umans", "conv2", 100, () => {
      queuedCalled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(queuedCalled).toBe(true);
    expect(manager.getStatus("umans")?.queued).toBe(1);

    // Release the slot — the queued request should be granted.
    release1();
    const release2 = await promise;
    release2();
  });

  it("onQueued is NOT called when the slot is granted immediately", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 2);

    let queuedCalled = false;
    const release = await manager.acquire("umans", "conv1", 0, () => {
      queuedCalled = true;
    });

    expect(queuedCalled).toBe(false);
    release();
  });

  // ─── Configurable cooldown ──────────────────────────────────────────────

  it("setCooldown changes the cooldown applied to subsequently recycled slots", async () => {
    const { manager, timers } = createManager({ releaseCooldownMs: 200 });
    manager.setLimit("umans", 1);

    const release1 = await manager.acquire("umans", "conv1", 0);
    expect(manager.getStatus("umans")?.cooldownMs).toBe(200);

    // Bump the cooldown to 500ms.
    manager.setCooldown("umans", 500);
    expect(manager.getStatus("umans")?.cooldownMs).toBe(500);

    // Queue a waiter.
    let resolved = false;
    const promise2 = manager.acquire("umans", "conv2", 100).then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Release — the NEW cooldown (500ms) applies.
    release1();
    expect(resolved).toBe(false);
    timers.advance(200); // old cooldown elapsed — still cooling (500ms now).
    expect(resolved).toBe(false);
    timers.advance(300); // 500ms total → slot recycled, waiter granted.
    const release2 = await promise2;
    expect(resolved).toBe(true);
    release2();
  });

  it("getCooldowns returns all configured cooldowns", () => {
    const { manager } = createManager({ releaseCooldownMs: 350 });
    manager.setLimit("umans", 4);
    manager.setCooldown("openai-compat", 100);

    const cooldowns = manager.getCooldowns();
    expect(cooldowns).toContainEqual({ providerId: "umans", cooldownMs: 350 });
    expect(cooldowns).toContainEqual({ providerId: "openai-compat", cooldownMs: 100 });
  });

  it("setCooldown does NOT impose a limit when none is configured (override seeds on setLimit)", async () => {
    const { manager } = createManager({ releaseCooldownMs: 350 });

    // Set a cooldown with NO limit configured yet.
    manager.setCooldown("umans", 500);
    expect(manager.getCooldown("umans")).toBe(500);
    // No limit → acquire must be unlimited (no state with a limit imposed).
    const release = await manager.acquire("umans", "conv1", 0);
    expect(typeof release).toBe("function");
    release();
    expect(manager.getStatus("umans")).toBeUndefined(); // no limit state created
    expect(manager.getLimit("umans")).toBeUndefined();

    // Now set a limit — the pending cooldown override seeds the new state.
    manager.setLimit("umans", 4);
    expect(manager.getStatus("umans")?.cooldownMs).toBe(500);
  });

  // ─── Adaptive headroom (reduce limit by 1 on 429) ────────────────────────

  it("reportRateLimit reduces the limit by 1 (one-way) and sets autoReduced notice", () => {
    const reduced: { providerId: string; newLimit: number; oldLimit: number }[] = [];
    const { manager } = createManager({
      onLimitReduced: (p, n, o) => reduced.push({ providerId: p, newLimit: n, oldLimit: o }),
    });
    manager.setLimit("umans", 4);

    manager.reportRateLimit("umans");

    expect(manager.getLimit("umans")).toBe(3);
    const status = manager.getStatus("umans");
    expect(status?.autoReduced).toBe(true);
    expect(status?.autoReducedFrom).toBe(4);
    expect(status?.notice).toContain("auto-reduced to 3");
    expect(reduced).toEqual([{ providerId: "umans", newLimit: 3, oldLimit: 4 }]);
  });

  it("repeated 429s keep reducing (4 -> 3 -> 2 -> 1) and never go below 1", () => {
    const { manager } = createManager();
    manager.setLimit("umans", 4);

    manager.reportRateLimit("umans");
    expect(manager.getLimit("umans")).toBe(3);
    manager.reportRateLimit("umans");
    expect(manager.getLimit("umans")).toBe(2);
    manager.reportRateLimit("umans");
    expect(manager.getLimit("umans")).toBe(1);
    // Already at the floor — stays 1.
    manager.reportRateLimit("umans");
    expect(manager.getLimit("umans")).toBe(1);
    const status = manager.getStatus("umans");
    expect(status?.autoReduced).toBe(true);
    // autoReducedFrom records the FIRST reduction's original limit (4).
    expect(status?.autoReducedFrom).toBe(4);
  });

  it("a MANUAL setLimit clears the auto-reduce notice", () => {
    const { manager } = createManager();
    manager.setLimit("umans", 4);
    manager.reportRateLimit("umans"); // 4 -> 3, autoReduced
    expect(manager.getStatus("umans")?.autoReduced).toBe(true);

    // User restores the limit manually.
    manager.setLimit("umans", 4);
    const status = manager.getStatus("umans");
    expect(status?.autoReduced).toBe(false);
    expect(status?.autoReducedFrom).toBeUndefined();
    expect(status?.notice).toBeUndefined();
  });

  it("removeLimit clears the auto-reduce state", () => {
    const { manager } = createManager();
    manager.setLimit("umans", 4);
    manager.reportRateLimit("umans"); // auto-reduced
    expect(manager.getStatus("umans")?.autoReduced).toBe(true);

    manager.removeLimit("umans");
    expect(manager.getStatus("umans")).toBeUndefined();
  });

  // ─── Usage gate (poll concurrent_sessions before granting queued agents) ─

  it("usage gate blocks a queued waiter while upstream concurrent_sessions >= limit", async () => {
    // Upstream always reports AT the limit (4) → the gate never admits.
    const { manager, timers } = createManager({
      fetchUsage: async () => ({ concurrentSessions: 4 }),
    });
    manager.setLimit("umans", 4);
    manager.setCooldown("umans", 0); // no cooldown — isolate the gate

    // Fill all 4 slots (fast-path, no gate).
    const releases = await Promise.all([
      manager.acquire("umans", "c1", 0),
      manager.acquire("umans", "c2", 0),
      manager.acquire("umans", "c3", 0),
      manager.acquire("umans", "c4", 0),
    ]);
    expect(manager.getStatus("umans")?.inFlight).toBe(4);

    // 5th agent queues.
    let resolved = false;
    const promise5 = manager.acquire("umans", "c5", 10).then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(manager.getStatus("umans")?.queued).toBe(1);

    // Release one slot. Cooldown is 0 → recycle polls upstream → 4 >= 4 → NOT granted.
    releases[0]?.();
    // Let the async poll settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(manager.getStatus("umans")?.queued).toBe(1);

    // Advance past the 1s fallback repoll — still 4 → still blocked.
    timers.advance(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const r of releases.slice(1)) r?.();
    void promise5;
  });

  it("usage gate admits a queued waiter once upstream concurrent_sessions < limit", async () => {
    // Upstream starts at the limit; drops to 3 after the release.
    let upstream = 4;
    const { manager } = createManager({
      fetchUsage: async () => ({ concurrentSessions: upstream }),
    });
    manager.setLimit("umans", 4);
    manager.setCooldown("umans", 0);

    const releases = await Promise.all([
      manager.acquire("umans", "c1", 0),
      manager.acquire("umans", "c2", 0),
      manager.acquire("umans", "c3", 0),
      manager.acquire("umans", "c4", 0),
    ]);

    let resolved = false;
    const promise5 = manager.acquire("umans", "c5", 10).then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Upstream now drops to 3 (the released session finally decremented).
    upstream = 3;
    // Release a slot → cooldown 0 → poll → 3 < 4 → admit the waiter.
    releases[0]?.();
    const release5 = await promise5;
    expect(resolved).toBe(true);
    expect(manager.getStatus("umans")?.queued).toBe(0);

    release5();
    for (const r of releases.slice(1)) r?.();
  });

  it("usage gate falls back to granting when fetchUsage returns undefined", async () => {
    const { manager } = createManager({
      fetchUsage: async () => undefined, // no usage info available
    });
    manager.setLimit("umans", 1);
    manager.setCooldown("umans", 0);

    const release1 = await manager.acquire("umans", "c1", 0);
    let resolved = false;
    const promise2 = manager.acquire("umans", "c2", 10).then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Release → poll returns undefined → fall back to cooldown-only (grant).
    release1();
    const release2 = await promise2;
    expect(resolved).toBe(true);
    release2();
  });

  it("usage gate admits at most ONE queued waiter per successful poll", async () => {
    let upstream = 4;
    const { manager } = createManager({
      fetchUsage: async () => ({ concurrentSessions: upstream }),
    });
    manager.setLimit("umans", 4);
    manager.setCooldown("umans", 0);

    const releases = await Promise.all([
      manager.acquire("umans", "c1", 0),
      manager.acquire("umans", "c2", 0),
      manager.acquire("umans", "c3", 0),
      manager.acquire("umans", "c4", 0),
    ]);

    // Queue two waiters.
    let r5 = false;
    let r6 = false;
    const p5 = manager.acquire("umans", "c5", 10).then((r) => {
      r5 = true;
      return r;
    });
    const p6 = manager.acquire("umans", "c6", 20).then((r) => {
      r6 = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getStatus("umans")?.queued).toBe(2);

    // Upstream drops to 3. Release one slot → poll 3 < 4 → admit ONE (c5).
    upstream = 3;
    releases[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(r5).toBe(true);
    expect(r6).toBe(false); // c6 still queued — needs another poll.
    expect(manager.getStatus("umans")?.queued).toBe(1);

    const release5 = await p5;
    release5();
    void p6;
    for (const r of releases.slice(1)) r?.();
  });

  it("usage gate clears the fallback repoll timer when the queue drains", () => {
    const { manager, timers } = createManager({
      fetchUsage: async () => ({ concurrentSessions: 0 }),
    });
    manager.setLimit("umans", 1);
    manager.setCooldown("umans", 0);

    return manager.acquire("umans", "c1", 0).then(async (release1) => {
      // Queue a waiter (arms the 1s fallback timer).
      const p2 = manager.acquire("umans", "c2", 10);
      await Promise.resolve();
      await Promise.resolve();

      // Release → poll 0 < 1 → grant → queue drains → fallback timer cleared.
      release1();
      const release2 = await p2;
      release2();

      // Advancing past 1s must NOT throw or fire at a drained state.
      expect(() => timers.advance(1000)).not.toThrow();
    });
  });
});
