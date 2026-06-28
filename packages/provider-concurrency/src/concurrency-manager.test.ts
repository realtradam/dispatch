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
  onUsagePollError?: (providerId: string, err: unknown) => void;
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
    ...(opts?.onUsagePollError !== undefined ? { onUsagePollError: opts.onUsagePollError } : {}),
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
    const release = await manager.acquire("unknown", "conv1", "default", 0);
    expect(typeof release).toBe("function");
    // No state → release is a no-op, no error.
    release();
    expect(manager.getStatus("unknown")).toBeUndefined();
  });

  it("grants immediately when under the limit", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 4);

    const release1 = await manager.acquire("umans", "conv1", "default", 0);
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

    const release1 = await manager.acquire("umans", "conv1", "default", 100);

    // Second request should block (at limit).
    let resolved = false;
    const promise2 = manager.acquire("umans", "conv2", "default", 200).then((r) => {
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
    const release0 = await manager.acquire("umans", "holder", "default", 0);

    // Three agents queue with different prompt start times.
    // Agent C started latest (t=300), Agent A started earliest (t=100).
    const results: string[] = [];
    const acquireAndRecord = (conv: string, promptAt: number) =>
      manager.acquire("umans", conv, "default", promptAt).then((r) => {
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

    const release1 = await manager.acquire("umans", "conv1", "default", 0);
    release1();

    // Simulate a 429 → queue pauses.
    manager.reportRateLimit("umans");
    const status = manager.getStatus("umans");
    expect(status?.paused).toBe(true);
    expect(status?.pausedUntil).toBe(30000);

    // A new acquire should block (paused, even though under limit).
    let resolved = false;
    const promise = manager.acquire("umans", "conv2", "default", 0).then((r) => {
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

    const release = await manager.acquire("umans", "conv1", "default", 0);
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
    await manager.acquire("umans", "holder", "default", 0);

    // Queue a waiter.
    let resolved = false;
    const promise = manager.acquire("umans", "waiter", "default", 10).then((r) => {
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

    const release1 = await manager.acquire("umans", "conv1", "default", 0);

    // Queue a waiter.
    let resolved = false;
    const promise = manager.acquire("umans", "conv2", "default", 100).then((r) => {
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

    const release1 = await manager.acquire("umans", "conv1", "default", 0);

    // Queue two waiters.
    const p2 = manager.acquire("umans", "conv2", "default", 100);
    const p3 = manager.acquire("umans", "conv3", "default", 200);
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

    const release = await manager.acquire("umans", "conv1", "default", 0);
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
      manager.acquire("umans", "conv1", "default", 0),
      manager.acquire("umans", "conv2", "default", 0),
      manager.acquire("umans", "conv3", "default", 0),
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

    const release1 = await manager.acquire("umans", "conv1", "default", 0);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);

    // Queue a waiter.
    let resolved = false;
    const promise2 = manager.acquire("umans", "conv2", "default", 100).then((r) => {
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

    const release = await manager.acquire("umans", "conv1", "default", 0);
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
    manager.acquire("umans", "conv1", "default", 0).then((release) => {
      release();
      // Now there's a pending cooldown timer — destroy should clean it up.
      expect(() => manager.destroy()).not.toThrow();
    });
  });

  it("onQueued is called when the request is enqueued (not granted immediately)", async () => {
    const { manager } = createManager();
    manager.setLimit("umans", 1);

    // Hold the single slot.
    const release1 = await manager.acquire("umans", "conv1", "default", 0);

    // Second request should trigger onQueued.
    let queuedCalled = false;
    const promise = manager.acquire("umans", "conv2", "default", 100, () => {
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
    const release = await manager.acquire("umans", "conv1", "default", 0, () => {
      queuedCalled = true;
    });

    expect(queuedCalled).toBe(false);
    release();
  });

  // ─── Configurable cooldown ──────────────────────────────────────────────

  it("setCooldown changes the cooldown applied to subsequently recycled slots", async () => {
    const { manager, timers } = createManager({ releaseCooldownMs: 200 });
    manager.setLimit("umans", 1);

    const release1 = await manager.acquire("umans", "conv1", "default", 0);
    expect(manager.getStatus("umans")?.cooldownMs).toBe(200);

    // Bump the cooldown to 500ms.
    manager.setCooldown("umans", 500);
    expect(manager.getStatus("umans")?.cooldownMs).toBe(500);

    // Queue a waiter.
    let resolved = false;
    const promise2 = manager.acquire("umans", "conv2", "default", 100).then((r) => {
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
    const release = await manager.acquire("umans", "conv1", "default", 0);
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
      manager.acquire("umans", "c1", "default", 0),
      manager.acquire("umans", "c2", "default", 0),
      manager.acquire("umans", "c3", "default", 0),
      manager.acquire("umans", "c4", "default", 0),
    ]);
    expect(manager.getStatus("umans")?.inFlight).toBe(4);

    // 5th agent queues.
    let resolved = false;
    const promise5 = manager.acquire("umans", "c5", "default", 10).then((r) => {
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
      manager.acquire("umans", "c1", "default", 0),
      manager.acquire("umans", "c2", "default", 0),
      manager.acquire("umans", "c3", "default", 0),
      manager.acquire("umans", "c4", "default", 0),
    ]);

    let resolved = false;
    const promise5 = manager.acquire("umans", "c5", "default", 10).then((r) => {
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

    const release1 = await manager.acquire("umans", "c1", "default", 0);
    let resolved = false;
    const promise2 = manager.acquire("umans", "c2", "default", 10).then((r) => {
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
      manager.acquire("umans", "c1", "default", 0),
      manager.acquire("umans", "c2", "default", 0),
      manager.acquire("umans", "c3", "default", 0),
      manager.acquire("umans", "c4", "default", 0),
    ]);

    // Queue two waiters.
    let r5 = false;
    let r6 = false;
    const p5 = manager.acquire("umans", "c5", "default", 10).then((r) => {
      r5 = true;
      return r;
    });
    const p6 = manager.acquire("umans", "c6", "default", 20).then((r) => {
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

    return manager.acquire("umans", "c1", "default", 0).then(async (release1) => {
      // Queue a waiter (arms the 1s fallback timer).
      const p2 = manager.acquire("umans", "c2", "default", 10);
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

  // ─── Bug 1: usage-gate fast-path anti-overshoot ─────────────────────────

  it("Bug 1: a concurrent acquire during a recycle-poll queues instead of fast-pathing (no overshoot)", async () => {
    // The poll resolves only on an explicit microtask flush (deferred), so a
    // concurrent acquire arriving mid-poll must see gatePolling/inflated inFlight.
    let resolvePoll: (snap: ProviderUsage) => void = () => {};
    const pollCalled: number[] = [];
    const { manager } = createManager({
      fetchUsage: () =>
        new Promise<ProviderUsage>((resolve) => {
          pollCalled.push(1);
          resolvePoll = resolve;
        }),
    });
    manager.setLimit("umans", 1);
    manager.setCooldown("umans", 0);

    // Hold the single slot.
    const release1 = await manager.acquire("umans", "c1", "default", 0);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);

    // Queue a waiter (c2). Cooldown is 0, but the gate defers admission until a poll.
    let c2Granted = false;
    const p2 = manager.acquire("umans", "c2", "default", 10).then((r) => {
      c2Granted = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();

    // Release c1 → recycle → poll started (inFlight held inflated during poll).
    release1();
    await Promise.resolve(); // let recycle schedule the poll
    await Promise.resolve();
    expect(pollCalled.length).toBeGreaterThanOrEqual(1);
    // inFlight is still 1 (the recycle's decrement is deferred until the poll).
    expect(manager.getStatus("umans")?.inFlight).toBe(1);

    // A NEW acquire arriving mid-poll: inFlight is 1 (== limit) → must QUEUE,
    // not fast-path. Even if it saw inFlight < limit, gatePolling would route it
    // through the queue. Either way it must NOT be granted yet.
    let c3Granted = false;
    const p3 = manager.acquire("umans", "c3", "default", 20).then((r) => {
      c3Granted = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(c3Granted).toBe(false);
    expect(manager.getStatus("umans")?.queued).toBeGreaterThanOrEqual(1);

    // Resolve the poll with room (0 < 1) → c2 admitted (inFlight: decrement then
    // re-increment for the grant). c3 stays queued (one admission per poll).
    resolvePoll({ concurrentSessions: 0 });
    const release2 = await p2;
    expect(c2Granted).toBe(true);
    // c3 NOT admitted by this poll (one per poll).
    expect(c3Granted).toBe(false);

    release2();
    void p3;
  });

  it("Bug 1: when no poll is in flight, the fast-path still grants immediately (common-case throughput preserved)", async () => {
    const { manager } = createManager({
      fetchUsage: async () => ({ concurrentSessions: 0 }),
    });
    manager.setLimit("umans", 4);

    // Nowhere near the limit, no recycle in progress → fast-path, no poll.
    const release = await manager.acquire("umans", "c1", "default", 0);
    expect(manager.getStatus("umans")?.inFlight).toBe(1);
    release();
  });

  // ─── Bug 2: fetchUsage exceptions don't become unhandled rejections ──────

  it("Bug 2: a throwing fetchUsage is treated as undefined (cooldown-only fallback) and fires onUsagePollError", async () => {
    let pollError: { providerId: string; err: unknown } | undefined;
    const { manager } = createManager({
      fetchUsage: async () => {
        throw new Error("usage endpoint exploded");
      },
      onUsagePollError: (providerId, err) => {
        pollError = { providerId, err };
      },
    });
    manager.setLimit("umans", 1);
    manager.setCooldown("umans", 0);

    const release1 = await manager.acquire("umans", "c1", "default", 0);
    // Queue a waiter; release → recycle → poll THROWS.
    const p2 = manager.acquire("umans", "c2", "default", 10);
    await Promise.resolve();
    await Promise.resolve();

    // Must NOT reject / throw unhandled — swallow + fall back to granting.
    release1();
    const release2 = await p2; // resolves (cooldown-only fallback grants).
    expect(release2).toBeTypeOf("function");
    expect(pollError?.providerId).toBe("umans");
    expect(pollError?.err).toBeInstanceOf(Error);
    release2();
  });

  it("Bug 2: no unhandled promise rejection is left when fetchUsage throws (process stays clean)", async () => {
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", handler);
    try {
      const { manager } = createManager({
        fetchUsage: async () => {
          throw new Error("boom");
        },
      });
      manager.setLimit("umans", 1);
      manager.setCooldown("umans", 0);

      const release1 = await manager.acquire("umans", "c1", "default", 0);
      manager.acquire("umans", "c2", "default", 10).then((r) => r()); // queue + auto-release
      await Promise.resolve();
      await Promise.resolve();
      release1();
      // Let the swallowed poll + grant settle fully.
      await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 5));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  // ─── Bug 3: persisted auto-reduced limit keeps its notice across restart ─

  it("Bug 3: restoreLimit (startup) preserves the auto-reduce notice that setLimit (manual) clears", () => {
    const { manager } = createManager();
    manager.setLimit("umans", 4);
    manager.reportRateLimit("umans"); // 4 -> 3, autoReduced
    expect(manager.getStatus("umans")?.autoReduced).toBe(true);
    expect(manager.getStatus("umans")?.autoReducedFrom).toBe(4);

    // Simulate a restart: a fresh manager restores the persisted limit (3) +
    // the auto-reduce marker (autoReducedFrom=4) via restoreLimit.
    const { manager: restarted } = createManager();
    restarted.restoreLimit("umans", 3, 4);
    const status = restarted.getStatus("umans");
    expect(status?.limit).toBe(3);
    expect(status?.autoReduced).toBe(true);
    expect(status?.autoReducedFrom).toBe(4);
    expect(status?.notice).toContain("auto-reduced to 3");

    // Contrast: a MANUAL setLimit clears the notice (user took control).
    restarted.setLimit("umans", 4);
    expect(restarted.getStatus("umans")?.autoReduced).toBe(false);
    expect(restarted.getStatus("umans")?.autoReducedFrom).toBeUndefined();
  });

  it("Bug 3: restoreLimit without autoReducedFrom does not synthesize a notice", () => {
    const { manager } = createManager();
    manager.restoreLimit("umans", 4);
    const status = manager.getStatus("umans");
    expect(status?.limit).toBe(4);
    expect(status?.autoReduced).toBe(false);
    expect(status?.notice).toBeUndefined();
  });
});

// ─── Starred-workspace priority tests ───────────────────────────────────────

describe("starred-workspace priority", () => {
  it("starred-workspace agents are admitted before non-starred (regardless of promptStartedAt)", async () => {
    // Use a callback backed by a Set so we can star/unstar at runtime.
    const starred = new Set<string>();
    const timers = createFakeTimers();
    const manager = createConcurrencyManager({
      now: timers.now,
      slotTimeoutMs: 5000,
      watchdogIntervalMs: 1000,
      defaultPauseMs: 30000,
      isWorkspaceStarred: (wsId: string) => starred.has(wsId),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    manager.setLimit("umans", 1);

    // Hold the single slot.
    const release0 = await manager.acquire("umans", "holder", "default", 0);

    // Three agents queue:
    //  - convA (workspace "ws-normal", promptAt=100) — non-starred, earliest
    //  - convB (workspace "ws-starred", promptAt=200) — starred, later
    //  - convC (workspace "ws-normal", promptAt=300) — non-starred, latest
    starred.add("ws-starred");

    const results: string[] = [];
    const acquireAndRecord = (conv: string, wsId: string, promptAt: number) =>
      manager.acquire("umans", conv, wsId, promptAt).then((r) => {
        results.push(conv);
        return r;
      });

    const pA = acquireAndRecord("convA", "ws-normal", 100);
    const pB = acquireAndRecord("convB", "ws-starred", 200);
    const pC = acquireAndRecord("convC", "ws-normal", 300);

    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([]); // none resolved yet.

    // Release the holder. The starred agent (convB, t=200) should get the
    // slot FIRST, even though convA (t=100) started earlier.
    release0();

    const rB = await pB;
    expect(results).toEqual(["convB"]);
    rB();

    // Now the oldest non-starred (convA, t=100) should be next.
    const rA = await pA;
    expect(results).toEqual(["convB", "convA"]);
    rA();

    // Then convC (t=300).
    const rC = await pC;
    expect(results).toEqual(["convB", "convA", "convC"]);
    rC();

    manager.destroy();
  });

  it("within the starred group, oldest-agent-first is preserved", async () => {
    const starred = new Set<string>(["ws-starred"]);
    const timers = createFakeTimers();
    const manager = createConcurrencyManager({
      now: timers.now,
      slotTimeoutMs: 5000,
      watchdogIntervalMs: 1000,
      defaultPauseMs: 30000,
      isWorkspaceStarred: (wsId: string) => starred.has(wsId),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    manager.setLimit("umans", 1);

    const release0 = await manager.acquire("umans", "holder", "default", 0);

    const results: string[] = [];
    const acquireAndRecord = (conv: string, wsId: string, promptAt: number) =>
      manager.acquire("umans", conv, wsId, promptAt).then((r) => {
        results.push(conv);
        return r;
      });

    // Two starred agents: convLate (t=300) queues first, convEarly (t=100) second.
    const pLate = acquireAndRecord("convLate", "ws-starred", 300);
    const pEarly = acquireAndRecord("convEarly", "ws-starred", 100);

    await Promise.resolve();
    await Promise.resolve();

    release0();

    // convEarly (t=100) should win within the starred group (oldest-first).
    const rEarly = await pEarly;
    expect(results).toEqual(["convEarly"]);
    rEarly();

    const rLate = await pLate;
    expect(results).toEqual(["convEarly", "convLate"]);
    rLate();

    manager.destroy();
  });

  it("starring a workspace while agents are queued re-prioritizes them immediately", async () => {
    const timers = createFakeTimers();
    const manager = createConcurrencyManager({
      now: timers.now,
      slotTimeoutMs: 5000,
      watchdogIntervalMs: 1000,
      defaultPauseMs: 30000,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    manager.setLimit("umans", 1);

    const release0 = await manager.acquire("umans", "holder", "default", 0);

    // convA (non-starred, t=100) queues first.
    let resolvedA = false;
    const pA = manager.acquire("umans", "convA", "ws-normal", 100).then((r) => {
      resolvedA = true;
      return r;
    });
    // convB (non-starred, t=200) queues second.
    let resolvedB = false;
    const pB = manager.acquire("umans", "convB", "ws-to-star", 200).then((r) => {
      resolvedB = true;
      return r;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolvedA).toBe(false);
    expect(resolvedB).toBe(false);

    // Now star convB's workspace AFTER it's queued. notifyWorkspaceStarred
    // updates the internal cache + re-sorts + tries to grant.
    manager.notifyWorkspaceStarred("ws-to-star", true);

    // Release the holder — convB (now starred) should jump ahead of convA.
    release0();

    const rB = await pB;
    expect(resolvedB).toBe(true);
    expect(resolvedA).toBe(false);
    rB();

    // Now convA gets the next slot.
    const rA = await pA;
    expect(resolvedA).toBe(true);
    rA();

    manager.destroy();
  });

  it("unstar a workspace demotes its queued agents", async () => {
    const timers = createFakeTimers();
    const manager = createConcurrencyManager({
      now: timers.now,
      slotTimeoutMs: 5000,
      watchdogIntervalMs: 1000,
      defaultPauseMs: 30000,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    manager.setLimit("umans", 1);

    // Initially star "ws-starred" via the internal cache.
    manager.notifyWorkspaceStarred("ws-starred", true);

    const release0 = await manager.acquire("umans", "holder", "default", 0);

    // convA (starred, t=200) queues first.
    const pA = manager.acquire("umans", "convA", "ws-starred", 200);
    // convB (non-starred, t=100) queues second but is older.
    const pB = manager.acquire("umans", "convB", "ws-normal", 100);

    await Promise.resolve();
    await Promise.resolve();

    // Unstar convA's workspace — it should now be behind convB (which is older).
    manager.notifyWorkspaceStarred("ws-starred", false);

    release0();

    // convB (t=100, now non-starred but oldest) should win.
    const rB = await pB;
    expect(rB).toBeDefined();
    rB();

    const rA = await pA;
    rA();

    manager.destroy();
  });

  it("notifyWorkspaceStarred re-sorts queues and tries to grant when capacity is free", async () => {
    const timers = createFakeTimers();
    const manager = createConcurrencyManager({
      now: timers.now,
      slotTimeoutMs: 5000,
      watchdogIntervalMs: 1000,
      defaultPauseMs: 30000,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    manager.setLimit("umans", 1);

    // Slot is held. Two agents queued (both non-starred).
    const release0 = await manager.acquire("umans", "holder", "default", 0);
    const pA = manager.acquire("umans", "convA", "ws-normal", 100);
    const pB = manager.acquire("umans", "convB", "ws-to-star", 200);

    await Promise.resolve();
    await Promise.resolve();

    // Star convB's workspace — notifyWorkspaceStarred re-sorts + tries to
    // grant. But the slot is still held, so no one is granted yet.
    manager.notifyWorkspaceStarred("ws-to-star", true);

    // Release the slot — convB (now starred) should get it.
    release0();

    const rB = await pB;
    expect(rB).toBeDefined();
    rB();

    const rA = await pA;
    rA();

    manager.destroy();
  });

  it("without isWorkspaceStarred callback, all agents are non-starred (backward compatible)", async () => {
    const timers = createFakeTimers();
    const manager = createConcurrencyManager({
      now: timers.now,
      slotTimeoutMs: 5000,
      watchdogIntervalMs: 1000,
      defaultPauseMs: 30000,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    manager.setLimit("umans", 1);

    const release0 = await manager.acquire("umans", "holder", "default", 0);

    const results: string[] = [];
    const acquireAndRecord = (conv: string, wsId: string, promptAt: number) =>
      manager.acquire("umans", conv, wsId, promptAt).then((r) => {
        results.push(conv);
        return r;
      });

    // Queue in non-sorted order: B (t=200), A (t=100).
    const pB = acquireAndRecord("convB", "ws-any", 200);
    const pA = acquireAndRecord("convA", "ws-any", 100);

    await Promise.resolve();
    await Promise.resolve();

    release0();

    // Without a callback, oldest-first ordering applies (no starred priority).
    const rA = await pA;
    expect(results).toEqual(["convA"]);
    rA();

    const rB = await pB;
    expect(results).toEqual(["convA", "convB"]);
    rB();

    manager.destroy();
  });
});
