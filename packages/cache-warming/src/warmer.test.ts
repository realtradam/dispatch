import {
  createBus,
  createHost,
  type Logger,
  type Span,
  type StorageNamespace,
} from "@dispatch/kernel";
import {
  cacheWarmHandle,
  conversationDeleted,
  type WarmResult,
  type WarmService,
  warmCompleted,
} from "@dispatch/session-orchestrator";
import {
  createSurfaceRegistry,
  createSurfaceRegistryExtension,
  surfaceRegistryHandle,
} from "@dispatch/surface-registry";
import { describe, expect, it, vi } from "vitest";
import {
  conversationStoreHandle,
  conversationDeleted as storeDeleted,
  extension as storeExtension,
} from "../../conversation-store/dist/index.js";
import { createExecBackendExtension } from "../../exec-backend/src/index.js";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { extension as promptExtension } from "../../system-prompt/src/index.js";
import { activate, createCacheWarmingExtension } from "./extension.js";
import { MIN_INTERVAL_MS } from "./pure.js";
import { createCacheWarmer, type TimerDeps } from "./warmer.js";

function memStorage(): StorageNamespace {
  const map = new Map<string, string>();
  return {
    ...storageFromMap(map),
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
    has: async (k) => map.has(k),
    keys: async (prefix) =>
      [...map.keys()].filter((k) => (prefix === undefined ? true : k.startsWith(prefix))),
  };
}

function makeSpan(): Span {
  const span: Span = {
    id: "span",
    log: makeLogger(),
    setAttributes: () => {},
    addLink: () => {},
    child: () => makeSpan(),
    end: () => {},
  };
  return span;
}

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeLogger(),
    span: () => makeSpan(),
  };
}

function fakeTimers(): TimerDeps & { flush: () => void; delays: () => number[] } {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    delays: () => [...pending.values()].map(({ ms }) => ms),
    flush() {
      const fns = [...pending.values()];
      pending.clear();
      for (const { fn } of fns) fn();
    },
  };
}

const WARM_RESULT: WarmResult = {
  inputTokens: 1000,
  outputTokens: 10,
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
};

function makeDeps(
  overrides: Partial<{
    warm: WarmService["warm"];
    onSurfaceChange: () => void;
    now: () => number;
  }> = {},
) {
  const timers = fakeTimers();
  let nowMs = 1000;
  return {
    timers,
    warm: overrides.warm ?? (async () => WARM_RESULT),
    storage: memStorage(),
    logger: makeLogger(),
    now: overrides.now ?? (() => nowMs),
    onSurfaceChange: overrides.onSurfaceChange ?? (() => {}),
    setNow(ms: number) {
      nowMs = ms;
    },
  };
}

describe("CacheWarmer", () => {
  it("arms a timer on turnSettled and warms when it fires (enabled)", async () => {
    const deps = makeDeps();
    const warmCalls: string[] = [];
    deps.warm = async (convId) => {
      warmCalls.push(convId);
      return WARM_RESULT;
    };
    const warmer = createCacheWarmer(deps);

    await warmer.setEnabled("conv-1", true);
    warmer.onTurnSettled("conv-1", {});
    deps.timers.flush();

    await new Promise((r) => setTimeout(r, 10));
    expect(warmCalls).toContain("conv-1");
  });

  it("warming is OFF by default — a new conversation never arms on turnSettled (CR-4a)", async () => {
    const deps = makeDeps();
    const warmCalls: string[] = [];
    deps.warm = async (convId) => {
      warmCalls.push(convId);
      return WARM_RESULT;
    };
    const warmer = createCacheWarmer(deps);

    expect(warmer.getState("conv-1").enabled).toBe(false);
    warmer.onTurnSettled("conv-1", {});
    expect(warmer.getState("conv-1").nextWarmAt).toBeNull();
    deps.timers.flush();

    await new Promise((r) => setTimeout(r, 10));
    expect(warmCalls).toHaveLength(0);
  });

  it("cancels the timer on turnStarted (no warm while generating)", () => {
    const deps = makeDeps();
    const warmCalls: string[] = [];
    deps.warm = async (convId) => {
      warmCalls.push(convId);
      return WARM_RESULT;
    };
    const warmer = createCacheWarmer(deps);

    warmer.onTurnSettled("conv-1", {});
    warmer.onTurnStarted("conv-1");
    deps.timers.flush();

    expect(warmCalls).toHaveLength(0);
  });

  it("disabled conversation does not warm", async () => {
    const deps = makeDeps();
    const warmCalls: string[] = [];
    deps.warm = async (convId) => {
      warmCalls.push(convId);
      return WARM_RESULT;
    };
    const warmer = createCacheWarmer(deps);

    await warmer.setEnabled("conv-1", false);
    warmer.onTurnSettled("conv-1", {});
    deps.timers.flush();

    await new Promise((r) => setTimeout(r, 10));
    expect(warmCalls).toHaveLength(0);
  });

  it("setIntervalMs converts seconds→ms, floors at MIN_INTERVAL_MS, and re-arms", async () => {
    const deps = makeDeps();
    const warmCalls: string[] = [];
    deps.warm = async (convId) => {
      warmCalls.push(convId);
      return WARM_RESULT;
    };
    const warmer = createCacheWarmer(deps);

    // Enable and settle to arm the timer
    await warmer.setEnabled("conv-1", true);
    warmer.onTurnSettled("conv-1", {});

    // Set interval to 30 seconds (30000ms)
    const settings = await warmer.setIntervalMs("conv-1", 30_000);
    expect(settings.intervalMs).toBe(30_000);

    const state = warmer.getState("conv-1");
    expect(state.intervalMs).toBe(30_000);

    // Timer should still be armed — flush fires it
    deps.timers.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(warmCalls).toContain("conv-1");
  });

  it("setIntervalMs clamps values below MIN_INTERVAL_MS", async () => {
    const deps = makeDeps();
    const warmer = createCacheWarmer(deps);

    warmer.onTurnSettled("conv-1", {});

    // Set interval to 500ms — should clamp to MIN_INTERVAL_MS (1000)
    const settings = await warmer.setIntervalMs("conv-1", 500);
    expect(settings.intervalMs).toBe(1000);
  });

  it("setIntervalMs ignores NaN / non-positive (clamps to MIN_INTERVAL_MS)", async () => {
    const deps = makeDeps();
    const warmer = createCacheWarmer(deps);

    warmer.onTurnSettled("conv-1", {});

    const settings1 = await warmer.setIntervalMs("conv-1", Number.NaN);
    expect(settings1.intervalMs).toBe(MIN_INTERVAL_MS);

    const settings2 = await warmer.setIntervalMs("conv-1", -5000);
    expect(settings2.intervalMs).toBe(MIN_INTERVAL_MS);

    const settings3 = await warmer.setIntervalMs("conv-1", 0);
    expect(settings3.intervalMs).toBe(MIN_INTERVAL_MS);
  });

  it("setEnabled flips enabled for a conversation", async () => {
    const deps = makeDeps();
    const warmer = createCacheWarmer(deps);

    // Default is DISABLED (opt-in per conversation)
    expect(warmer.getState("conv-1").enabled).toBe(false);

    // Toggle on
    await warmer.setEnabled("conv-1", true);
    expect(warmer.getState("conv-1").enabled).toBe(true);

    // Toggle off
    await warmer.setEnabled("conv-1", false);
    expect(warmer.getState("conv-1").enabled).toBe(false);
  });

  it("re-enabling restores the PERSISTED interval into runtime state", async () => {
    const deps = makeDeps();
    const warmer = createCacheWarmer(deps);

    await warmer.setIntervalMs("conv-1", 30_000);
    await warmer.setEnabled("conv-1", false);

    // Fresh warmer over the same storage (simulates restart)
    const warmer2 = createCacheWarmer(deps);
    expect(warmer2.getState("conv-1").intervalMs).toBe(240_000); // runtime default
    await warmer2.setEnabled("conv-1", true);
    expect(warmer2.getState("conv-1").intervalMs).toBe(30_000); // persisted restored
  });

  it("onSurfaceChange is called when settings change", async () => {
    let changeCount = 0;
    const deps = makeDeps({
      onSurfaceChange: () => {
        changeCount++;
      },
    });
    const warmer = createCacheWarmer(deps);

    await warmer.setEnabled("conv-1", false);
    expect(changeCount).toBe(1);

    await warmer.setIntervalMs("conv-1", 30_000);
    expect(changeCount).toBe(2);
  });

  it("warmCompleted updates lastPct/lastExpectedPct/lastWarmAt and re-arms (nextWarmAt set), pushes onSurfaceChange", async () => {
    let changeCount = 0;
    let nowMs = 5000;
    const deps = makeDeps({
      onSurfaceChange: () => {
        changeCount++;
      },
      now: () => nowMs,
    });
    const warmer = createCacheWarmer(deps);

    await warmer.setEnabled("conv-1", true);
    warmer.onTurnSettled("conv-1", {});
    const stateBefore = warmer.getState("conv-1");
    expect(stateBefore.lastPct).toBeNull();
    expect(stateBefore.lastExpectedPct).toBeNull();
    expect(stateBefore.lastWarmAt).toBeNull();

    const countBefore = changeCount;
    nowMs = 6000;
    warmer.onWarmCompleted({
      conversationId: "conv-1",
      usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 700, cacheWriteTokens: 300 },
    });

    const state = warmer.getState("conv-1");
    expect(state.lastPct).toBe(70);
    expect(state.lastExpectedPct).toBe(70);
    expect(state.lastWarmAt).toBe(6000);
    expect(state.nextWarmAt).not.toBeNull();
    expect(changeCount).toBe(countBefore + 1);
  });

  it("the post-warm surface notify observes the NEW future nextWarmAt, not the consumed one (CR-4b)", async () => {
    let nowMs = 5000;
    const observed: (number | null)[] = [];
    const deps = makeDeps({ now: () => nowMs });
    const warmer = createCacheWarmer(deps);
    deps.onSurfaceChange = () => {
      observed.push(warmer.getState("conv-1").nextWarmAt);
    };

    await warmer.setEnabled("conv-1", true);
    warmer.onTurnSettled("conv-1", {});
    observed.length = 0;

    nowMs = 9000;
    warmer.onWarmCompleted({ conversationId: "conv-1", usage: WARM_RESULT });

    // Exactly one notify, and AT NOTIFY TIME the state already carried the
    // re-armed, future fire time (lastWarmAt + interval) — never the past one.
    expect(observed).toEqual([9000 + 240_000]);
  });

  it("the post-warm surface notify carries nextWarmAt: null when warming was disabled mid-flight", async () => {
    let nowMs = 5000;
    const observed: (number | null)[] = [];
    const deps = makeDeps({ now: () => nowMs });
    const warmer = createCacheWarmer(deps);
    deps.onSurfaceChange = () => {
      observed.push(warmer.getState("conv-1").nextWarmAt);
    };

    await warmer.setEnabled("conv-1", true);
    warmer.onTurnSettled("conv-1", {});
    await warmer.setEnabled("conv-1", false);
    observed.length = 0;

    nowMs = 9000;
    warmer.onWarmCompleted({ conversationId: "conv-1", usage: WARM_RESULT });

    // Not re-armed (disabled) — the notify must NOT carry a stale past value.
    expect(observed).toEqual([null]);
  });

  it("onTurnSettled pushes a surface notify carrying the fresh schedule (CR-4b post-seal path)", async () => {
    let nowMs = 5000;
    const observed: (number | null)[] = [];
    const deps = makeDeps({ now: () => nowMs });
    const warmer = createCacheWarmer(deps);
    deps.onSurfaceChange = () => {
      observed.push(warmer.getState("conv-1").nextWarmAt);
    };

    await warmer.setEnabled("conv-1", true);
    warmer.onTurnStarted("conv-1");
    observed.length = 0;

    nowMs = 12_000;
    warmer.onTurnSettled("conv-1", {});

    // At notify time the new schedule is already armed.
    expect(observed).toEqual([12_000 + 240_000]);
  });

  it("a warm that completes while the conversation is active is dropped (no update, no re-arm)", async () => {
    let changeCount = 0;
    const deps = makeDeps({
      onSurfaceChange: () => {
        changeCount++;
      },
      now: () => 5000,
    });
    const warmer = createCacheWarmer(deps);

    await warmer.setEnabled("conv-1", true);
    warmer.onTurnSettled("conv-1", {});
    warmer.onTurnStarted("conv-1");

    const countBefore = changeCount;
    warmer.onWarmCompleted({
      conversationId: "conv-1",
      usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 0 },
    });

    const state = warmer.getState("conv-1");
    expect(state.lastPct).toBeNull();
    expect(state.lastWarmAt).toBeNull();
    expect(state.nextWarmAt).toBeNull();
    expect(changeCount).toBe(countBefore);
  });

  it("nextWarmAt is set when armed and null when disabled or active", async () => {
    let nowMs = 1000;
    const deps = makeDeps({ now: () => nowMs });
    const warmer = createCacheWarmer(deps);

    // Before any event — not armed
    expect(warmer.getState("conv-1").nextWarmAt).toBeNull();

    // After enable + turnSettled — armed with nextWarmAt
    await warmer.setEnabled("conv-1", true);
    nowMs = 2000;
    warmer.onTurnSettled("conv-1", {});
    const stateArmed = warmer.getState("conv-1");
    expect(stateArmed.nextWarmAt).toBe(2000 + 240_000);

    // After turnStarted — cancelled (null)
    warmer.onTurnStarted("conv-1");
    expect(warmer.getState("conv-1").nextWarmAt).toBeNull();

    // After disabling — null
    await warmer.setEnabled("conv-2", true);
    warmer.onTurnSettled("conv-2", {});
    await warmer.setEnabled("conv-2", false);
    expect(warmer.getState("conv-2").nextWarmAt).toBeNull();
  });

  it("a manual warm (warmCompleted for a conversation) resets the timer + refreshes the surface", async () => {
    let changeCount = 0;
    let nowMs = 5000;
    const deps = makeDeps({
      onSurfaceChange: () => {
        changeCount++;
      },
      now: () => nowMs,
    });
    const warmer = createCacheWarmer(deps);

    // Enable + settle to arm the timer
    await warmer.setEnabled("conv-1", true);
    warmer.onTurnSettled("conv-1", {});
    const armed = warmer.getState("conv-1");
    expect(armed.nextWarmAt).toBe(5000 + 240_000);

    // Simulate a manual warm completing at t=8000
    const countBefore = changeCount;
    nowMs = 8000;
    warmer.onWarmCompleted({
      conversationId: "conv-1",
      usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 100 },
    });

    const after = warmer.getState("conv-1");
    expect(after.lastPct).toBe(90);
    expect(after.lastExpectedPct).toBe(90);
    expect(after.lastWarmAt).toBe(8000);
    // Timer should be re-armed with new nextWarmAt
    expect(after.nextWarmAt).toBe(8000 + 240_000);
    expect(changeCount).toBe(countBefore + 1);
  });

  it("stores lastPct from the warmCompleted event", () => {
    const deps = makeDeps({ now: () => 5000 });
    const warmer = createCacheWarmer(deps);

    warmer.onTurnSettled("conv-1", {});
    warmer.onWarmCompleted({
      conversationId: "conv-1",
      usage: WARM_RESULT,
    });

    const state = warmer.getState("conv-1");
    expect(state.lastPct).toBe(80);
  });

  it("a completed warm stores both lastPct (rate) and lastExpectedPct (retention)", () => {
    const deps = makeDeps({ now: () => 5000 });
    const warmer = createCacheWarmer(deps);

    warmer.onTurnSettled("conv-1", {});
    warmer.onWarmCompleted({
      conversationId: "conv-1",
      usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 700, cacheWriteTokens: 300 },
    });

    const state = warmer.getState("conv-1");
    expect(state.lastPct).toBe(70);
    expect(state.lastExpectedPct).toBe(70);
  });

  it("re-arms timer after warmCompleted", async () => {
    let nowMs = 1000;
    const deps = makeDeps({ now: () => nowMs });
    const warmer = createCacheWarmer(deps);

    await warmer.setEnabled("conv-1", true);
    warmer.onTurnSettled("conv-1", {});
    const firstNextWarmAt = warmer.getState("conv-1").nextWarmAt;

    nowMs = 5000;
    warmer.onWarmCompleted({
      conversationId: "conv-1",
      usage: WARM_RESULT,
    });

    const after = warmer.getState("conv-1");
    expect(after.nextWarmAt).not.toBeNull();
    expect(after.nextWarmAt).not.toBe(firstNextWarmAt);
    expect(after.nextWarmAt).toBe(5000 + 240_000);
  });

  it("onConversationClosed cancels the schedule, disables warming, persists OFF, and notifies (CR-4c)", async () => {
    let changeCount = 0;
    const deps = makeDeps({
      onSurfaceChange: () => {
        changeCount++;
      },
      now: () => 5000,
    });
    const warmCalls: string[] = [];
    deps.warm = async (convId) => {
      warmCalls.push(convId);
      return WARM_RESULT;
    };
    const warmer = createCacheWarmer(deps);

    await warmer.setEnabled("conv-1", true);
    warmer.onTurnSettled("conv-1", {});
    expect(warmer.getState("conv-1").nextWarmAt).not.toBeNull();

    const countBefore = changeCount;
    await warmer.onConversationClosed("conv-1");

    const state = warmer.getState("conv-1");
    expect(state.enabled).toBe(false);
    expect(state.nextWarmAt).toBeNull();
    expect(changeCount).toBe(countBefore + 1);

    // The pending timer is cancelled — flushing fires nothing.
    deps.timers.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(warmCalls).toHaveLength(0);

    // Persisted OFF: a fresh warmer over the same storage stays disabled on enable-read.
    const raw = await deps.storage.get("settings:conv-1");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).enabled).toBe(false);
  });

  it("a turnSettled racing a close does not re-arm (enabled flipped synchronously)", async () => {
    const deps = makeDeps({ now: () => 5000 });
    const warmer = createCacheWarmer(deps);

    await warmer.setEnabled("conv-1", true);
    warmer.onTurnStarted("conv-1");

    // Close while "generating" — do NOT await: the sync part must suffice.
    const closed = warmer.onConversationClosed("conv-1");
    // The turn settles immediately after the close was issued.
    warmer.onTurnSettled("conv-1", {});

    expect(warmer.getState("conv-1").enabled).toBe(false);
    expect(warmer.getState("conv-1").nextWarmAt).toBeNull();
    await closed;
  });

  it("the per-conversation spec includes a cache-retention stat", () => {
    const deps = makeDeps({ now: () => 5000 });
    const warmer = createCacheWarmer(deps);

    warmer.onTurnSettled("conv-1", {});
    warmer.onWarmCompleted({
      conversationId: "conv-1",
      usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 100 },
    });

    const state = warmer.getState("conv-1");
    expect(state.lastExpectedPct).toBe(90);
  });

  it.each([
    {
      name: "synchronous throw",
      warm: () => {
        throw new Error("warm unavailable");
      },
    },
    {
      name: "rejected Error",
      warm: async () => {
        throw new Error("warm unavailable");
      },
    },
    {
      name: "rejected string",
      warm: async () => {
        throw "warm unavailable";
      },
    },
  ])("catches $name, logs and re-arms without unhandled rejection", async ({ warm }) => {
    const deps = makeDeps({ warm });
    const logs: unknown[] = [];
    deps.logger.error = (_message, attrs) => {
      logs.push(attrs);
    };
    const warmer = createCacheWarmer(deps);
    const observed: unknown[] = [];
    deps.onSurfaceChange = () => {
      observed.push(warmer.getState("conv-1"));
    };
    await warmer.setEnabled("conv-1", true);
    observed.length = 0;
    deps.timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.timers.delays()).toEqual([480_000]);
    expect(warmer.getState("conv-1")).toMatchObject({
      lastError: "warm unavailable",
      nextWarmAt: 481_000,
      lastWarmAt: null,
    });
    expect(logs).toEqual([
      expect.objectContaining({ conversationId: "conv-1", error: "warm unavailable" }),
    ]);
    expect(observed).toEqual([
      expect.objectContaining({ lastError: "warm unavailable", nextWarmAt: 481_000 }),
    ]);
    warmer.dispose();
  });

  it("backs off error results at 2× then 4× (capped), resets after success, and isolates conversations", async () => {
    const deps = makeDeps({ warm: async () => ({ error: "provider unavailable" }) });
    const logs: unknown[] = [];
    deps.logger.error = (_message, attrs) => {
      logs.push(attrs);
    };
    const warmer = createCacheWarmer(deps);
    await warmer.setIntervalMs("conv-1", 10_000);
    await warmer.setEnabled("conv-1", true);
    for (const delay of [20_000, 40_000, 40_000]) {
      deps.timers.flush();
      await Promise.resolve();
      expect(deps.timers.delays()).toEqual([delay]);
      expect(warmer.getState("conv-1").lastError).toBe("provider unavailable");
    }
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ conversationId: "conv-1", error: "provider unavailable" });
    await warmer.setIntervalMs("conv-1", 5_000);
    expect(deps.timers.delays()).toEqual([20_000]);
    await warmer.setIntervalMs("conv-1", 10_000);
    await warmer.setEnabled("conv-2", true);
    expect(deps.timers.delays()).toEqual([40_000, 240_000]);
    await warmer.setEnabled("conv-2", false);
    deps.warm = async () => {
      warmer.onWarmCompleted({ conversationId: "conv-1", usage: WARM_RESULT });
      return WARM_RESULT;
    };
    deps.timers.flush();
    await Promise.resolve();
    expect(deps.timers.delays()).toEqual([10_000]);
    expect(warmer.getState("conv-1")).toMatchObject({ lastError: null, lastPct: 80 });
    deps.warm = async () => ({ error: "failed again" });
    deps.timers.flush();
    await Promise.resolve();
    expect(deps.timers.delays()).toEqual([20_000]);
    warmer.dispose();
  });

  it.each([
    "active",
    "disabled",
    "closed",
    "rescheduled",
    "disposed",
  ])("does not re-arm a stale warm failure after %s", async (action) => {
    let fail: (value: { error: string }) => void = () => {};
    const deps = makeDeps({
      warm: () =>
        new Promise((resolve) => {
          fail = resolve;
        }),
    });
    const warmer = createCacheWarmer(deps);
    await warmer.setEnabled("conv-1", true);
    deps.timers.flush();
    if (action === "active" || action === "rescheduled") warmer.onTurnStarted("conv-1");
    if (action === "disabled") await warmer.setEnabled("conv-1", false);
    if (action === "closed") await warmer.onConversationClosed("conv-1");
    if (action === "rescheduled") warmer.onTurnSettled("conv-1", {});
    if (action === "disposed") warmer.dispose();
    const before = warmer.getState("conv-1");
    fail({ error: "late failure" });
    await Promise.resolve();
    expect(warmer.getState("conv-1")).toEqual(before);
    expect(deps.timers.delays()).toEqual(action === "rescheduled" ? [240_000] : []);
    warmer.dispose();
  });

  it("pushes the last warm error through the registered surface and clears it after success", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const bus = createBus(logger);
    const registry = createSurfaceRegistry();
    const host = createHost([], {
      logger,
      bus,
      storageFactory: () => memStorage(),
      config: { get: () => undefined, getAll: () => ({}) },
      secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
      permissions: { check: async () => ({ allowed: true }) },
      scheduler: { register: () => {}, unregister: () => {} },
      events: { emit: () => {} },
      logSink: { emit: () => {} },
      logDeps: { now: () => Date.now(), newId: () => "test" },
    });
    const api = host.getHostAPI();
    const removeWarm = api.provideService(cacheWarmHandle, {
      warm: async () => ({ error: "surface failure" }),
    });
    const removeRegistry = api.provideService(surfaceRegistryHandle, registry);
    try {
      activate(api);
      const surface = registry.getSurface("cache-warming");
      if (surface === undefined) throw new Error("surface not registered");
      const context = { conversationId: "conv-1" };
      const observed: unknown[] = [];
      const unsubscribe = surface.subscribe?.(() => {
        observed.push(surface.getSpec(context));
      });
      await surface.invoke("cache-warming/toggle", undefined, context);
      await vi.advanceTimersByTimeAsync(240_000);
      expect(observed.at(-1)).toMatchObject({
        fields: expect.arrayContaining([
          { kind: "stat", label: "Last Error", value: "surface failure" },
        ]),
      });
      expect(vi.getTimerCount()).toBe(1);
      api.emit(warmCompleted, { conversationId: "conv-1", usage: WARM_RESULT });
      expect((await surface.getSpec(context)).fields).toContainEqual({
        kind: "stat",
        label: "Last Error",
        value: "—",
      });
      await surface.invoke("cache-warming/toggle", undefined, context);
      expect(vi.getTimerCount()).toBe(0);
      unsubscribe?.();
    } finally {
      removeWarm();
      removeRegistry();
      await host.deactivate();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

it("real store deletion cleans prompt/warming rows and schedules; subscriptions dispose on unload", async () => {
  vi.useFakeTimers();
  const namespaces = new Map<string, Map<string, string>>();
  const host = createHost(
    [
      storeExtension,
      promptExtension,
      createCacheWarmingExtension(),
      createExecBackendExtension(),
      createSurfaceRegistryExtension(),
      {
        manifest: {
          id: "session-orchestrator",
          name: "warm boundary",
          version: "0.0.0",
          apiVersion: "^0.1.0",
          tier: "core",
          trust: "bundled",
        },
        activate: (api) => {
          api.provideService(cacheWarmHandle, { warm: async () => WARM_RESULT });
        },
      },
    ],
    {
      logger: makeLogger(),
      bus: createBus(makeLogger()),
      storageFactory: (name) => {
        let data = namespaces.get(name);
        if (!data) {
          data = new Map();
          namespaces.set(name, data);
        }
        return storageFromMap(data);
      },
      config: { get: () => undefined, getAll: () => ({}) },
      secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
      permissions: { check: async () => ({ allowed: true }) },
      scheduler: { register: () => {}, unregister: () => {} },
      events: { emit: () => {} },
      logSink: { emit: () => {} },
      logDeps: { now: () => 0, newId: () => "test" },
    },
  );
  const api = host.getHostAPI();
  try {
    await host.activate();
    const registry = api.getService(surfaceRegistryHandle);
    expect(conversationDeleted).toBe(storeDeleted);
    const store = api.getService(conversationStoreHandle);
    const promptRows = namespaces.get("system-prompt");
    if (!promptRows) throw new Error("prompt not loaded");
    promptRows.set("template", "keep global template");
    for (const id of ["deleted", "keep"]) {
      await store.setConversationTitle(id, id);
      for (const prefix of ["resolved:", "resolved-cwd:", "resolved-computer:"])
        promptRows.set(prefix + id, id);
      await registry
        .getSurface("cache-warming")
        ?.invoke("cache-warming/toggle", undefined, { conversationId: id });
    }
    expect(vi.getTimerCount()).toBe(2);
    await store.deleteConversation("deleted");
    await vi.advanceTimersByTimeAsync(0);
    expect([...promptRows.keys()]).toEqual([
      "template",
      "resolved:keep",
      "resolved-cwd:keep",
      "resolved-computer:keep",
    ]);
    expect(namespaces.get("cache-warming")?.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await store.deleteConversation("deleted");
    for (const id of ["system-prompt", "cache-warming"]) {
      const unloaded = await host.unloadExtension(id);
      expect(unloaded).toMatchObject({ ok: true });
      expect(unloaded.dangling ?? []).toEqual([]);
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(registry.getSurface("cache-warming")).toBeUndefined();
    await store.deleteConversation("keep");
    await vi.advanceTimersByTimeAsync(0);
    expect(promptRows.get("resolved:keep")).toBe("keep");
    expect(namespaces.get("cache-warming")?.size).toBe(1);
  } finally {
    await host.deactivate();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("deletion invalidates late warm success/failure and forgets settings/context", async () => {
  let fail = (_result: { error: string }) => {};
  const deps = makeDeps({
    warm: () =>
      new Promise((resolve) => {
        fail = resolve;
      }),
  });
  const warmer = createCacheWarmer(deps);
  await warmer.setEnabled("deleted", true);
  warmer.onTurnSettled("deleted", { cwd: "/fixture" });
  deps.timers.flush();
  await warmer.onConversationDeleted("deleted");
  fail({ error: "late failure" });
  await Promise.resolve();
  warmer.onWarmCompleted({ conversationId: "deleted", usage: WARM_RESULT });
  warmer.onTurnSettled("deleted", { cwd: "/stale" });
  await warmer.onConversationClosed("deleted");
  await warmer.setEnabled("deleted", true);
  await warmer.setIntervalMs("deleted", 60_000);
  expect(await deps.storage.keys()).toEqual([]);
  expect(warmer.getContext("deleted")).toEqual({});
  expect(warmer.getState("deleted")).toMatchObject({
    enabled: false,
    lastError: null,
    lastWarmAt: null,
  });
  expect(deps.timers.delays()).toEqual([]);
  warmer.dispose();
});

it.each([
  "enable",
  "interval",
])("a pending %s settings read cannot recreate deleted rows", async (action) => {
  const deps = makeDeps();
  let release = (_value: string | null) => {};
  const reading = new Promise<string | null>((resolve) => {
    release = resolve;
  });
  const warmer = createCacheWarmer({ ...deps, storage: { ...deps.storage, get: () => reading } });
  const update =
    action === "enable"
      ? warmer.setEnabled("deleted", true)
      : warmer.setIntervalMs("deleted", 60_000);
  await warmer.onConversationDeleted("deleted");
  release(null);
  await update;
  expect(await deps.storage.keys()).toEqual([]);
  expect(warmer.getState("deleted").enabled).toBe(false);
  expect(deps.timers.delays()).toEqual([]);
  warmer.dispose();
});
