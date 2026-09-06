import { beforeEach, describe, expect, it } from "vitest";
import { defineEventHook, defineFilter, defineService } from "../contracts/hooks.js";
import type { Logger, Span } from "../contracts/logging.js";
import { type Bus, createBus } from "./bus.js";
import { applyFilterChain, dispatchEventSync, sortFilters } from "./pure.js";

interface FakeLogger extends Logger {
  readonly errors: Array<{ message: string; args: unknown[] }>;
}

function createFakeLogger(): FakeLogger {
  const errors: Array<{ message: string; args: unknown[] }> = [];
  const logger: FakeLogger = {
    errors,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message, attrs) => {
      errors.push({ message, args: attrs === undefined ? [] : [attrs] });
    },
    child: () => logger,
    span: () => makeNoopSpan(logger),
  };
  return logger;
}

function makeNoopSpan(log: Logger): Span {
  const span: Span = {
    id: "noop",
    log,
    setAttributes: () => {},
    addLink: () => {},
    child: () => span,
    end: () => {},
  };
  return span;
}

describe("event hooks", () => {
  let logger: FakeLogger;
  let bus: Bus;

  beforeEach(() => {
    logger = createFakeLogger();
    bus = createBus(logger);
  });

  it("fires all registered listeners", () => {
    const hook = defineEventHook<{ value: number }>("test/event");
    const received: number[] = [];

    bus.on(hook, (payload) => {
      received.push(payload.value);
    });
    bus.on(hook, (payload) => {
      received.push(payload.value * 10);
    });

    bus.emit(hook, { value: 3 });

    expect(received).toEqual([3, 30]);
  });

  it("isolates a throwing listener (others still run, error logged)", () => {
    const hook = defineEventHook<string>("test/isolate");
    const received: string[] = [];

    bus.on(hook, () => {
      throw new Error("boom");
    });
    bus.on(hook, (payload) => {
      received.push(payload);
    });

    bus.emit(hook, "hello");

    expect(received).toEqual(["hello"]);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("test/isolate");
  });

  it("isolates an async handler rejection", async () => {
    const hook = defineEventHook<string>("test/async-reject");
    const received: string[] = [];

    bus.on(hook, async () => {
      throw new Error("async boom");
    });
    bus.on(hook, async (payload) => {
      received.push(payload);
    });

    bus.emit(hook, "data");

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(received).toEqual(["data"]);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("test/async-reject");
  });

  it("unsubscribe removes the handler", () => {
    const hook = defineEventHook<void>("test/unsub");
    let count = 0;

    const unsub = bus.on(hook, () => {
      count++;
    });

    bus.emit(hook, undefined);
    expect(count).toBe(1);

    unsub();
    bus.emit(hook, undefined);
    expect(count).toBe(1);
  });

  it("emit with no handlers is a no-op", () => {
    const hook = defineEventHook<string>("test/empty");
    expect(() => bus.emit(hook, "nothing")).not.toThrow();
  });

  it("emitAsync awaits all handlers", async () => {
    const hook = defineEventHook<number>("test/async");
    const received: number[] = [];

    bus.on(hook, async (payload) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      received.push(payload);
    });
    bus.on(hook, async (payload) => {
      received.push(payload * 2);
    });

    await bus.emitAsync(hook, 5);

    expect(received).toEqual([10, 5]);
  });

  it("emitAsync respects timeout", async () => {
    const hook = defineEventHook<void>("test/timeout");
    let completed = false;

    bus.on(hook, async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      completed = true;
    });

    await bus.emitAsync(hook, undefined, 10);

    expect(completed).toBe(false);
  });
});

describe("filter hooks", () => {
  let logger: FakeLogger;
  let bus: Bus;

  beforeEach(() => {
    logger = createFakeLogger();
    bus = createBus(logger);
  });

  it("chains filters in registration order", async () => {
    const hook = defineFilter<string>("test/chain");

    bus.addFilter(hook, (value) => `${value}-a`);
    bus.addFilter(hook, (value) => `${value}-b`);

    const result = await bus.applyFilters(hook, "start");
    expect(result).toBe("start-a-b");
  });

  it("respects priority ordering (lower runs first)", async () => {
    const hook = defineFilter<string>("test/priority");

    bus.addFilter(hook, (value) => `${value}-second`);
    bus.addFilter(hook, (value) => `${value}-first`, { priority: -1 });

    const result = await bus.applyFilters(hook, "start");
    expect(result).toBe("start-first-second");
  });

  it("fail-open passes value through on throw", async () => {
    const hook = defineFilter<number>("test/fail-open");

    bus.addFilter(hook, (value) => value + 1);
    bus.addFilter(hook, () => {
      throw new Error("filter boom");
    });
    bus.addFilter(hook, (value) => value * 2);

    const result = await bus.applyFilters(hook, 5);
    expect(result).toBe(12);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("test/fail-open");
  });

  it("fail-closed propagates the error", async () => {
    const hook = defineFilter<number>("test/fail-closed");

    bus.addFilter(hook, () => {
      throw new Error("closed boom");
    });

    await expect(bus.applyFilters(hook, 5, { failClosed: true })).rejects.toThrow("closed boom");
  });

  it("applyFilters with no filters returns value unchanged", async () => {
    const hook = defineFilter<string>("test/no-filters");
    const result = await bus.applyFilters(hook, "unchanged");
    expect(result).toBe("unchanged");
  });

  it("unsubscribe removes a filter from the chain", async () => {
    const hook = defineFilter<string>("test/filter-unsub");

    const unsub = bus.addFilter(hook, (value) => `${value}-removed`);
    bus.addFilter(hook, (value) => `${value}-kept`);

    unsub();

    const result = await bus.applyFilters(hook, "start");
    expect(result).toBe("start-kept");
  });
});

describe("services", () => {
  let logger: FakeLogger;
  let bus: Bus;

  beforeEach(() => {
    logger = createFakeLogger();
    bus = createBus(logger);
  });

  it("provide and get round-trips", () => {
    const handle = defineService<{ greet: (name: string) => string }>("test/service");
    const impl = { greet: (name: string) => `hello ${name}` };

    bus.provideService(handle, impl);
    const retrieved = bus.getService(handle);

    expect(retrieved.greet("world")).toBe("hello world");
  });

  it("getService on missing service throws", () => {
    const handle = defineService<string>("test/missing");
    expect(() => bus.getService(handle)).toThrow("test/missing");
  });

  it("double-provide throws", () => {
    const handle = defineService<number>("test/double");

    bus.provideService(handle, 1);
    expect(() => bus.provideService(handle, 2)).toThrow("test/double");
  });

  it("un-provide disposer removes the service (getService throws again)", () => {
    const handle = defineService<number>("test/unprovide");

    const unprovide = bus.provideService(handle, 7);
    expect(bus.getService(handle)).toBe(7);

    unprovide();
    expect(() => bus.getService(handle)).toThrow("test/unprovide");
  });

  it("un-provide disposer is idempotent (double call is a no-op)", () => {
    const handle = defineService<number>("test/unprovide-twice");

    const unprovide = bus.provideService(handle, 7);
    unprovide();
    expect(() => unprovide()).not.toThrow();
  });

  it("re-provide after un-provide succeeds", () => {
    const handle = defineService<number>("test/reprovide");

    const unprovide = bus.provideService(handle, 1);
    unprovide();
    bus.provideService(handle, 2);
    expect(bus.getService(handle)).toBe(2);
  });

  it("a stale un-provide disposer does not evict a newer registration", () => {
    const handle = defineService<number>("test/stale-disposer");

    const stale = bus.provideService(handle, 1);
    stale();
    bus.provideService(handle, 2);
    // the old disposer must not remove the NEW implementation
    stale();
    expect(bus.getService(handle)).toBe(2);
  });
});

describe("reactive service registry (plan 03)", () => {
  let logger: FakeLogger;
  let bus: Bus;

  beforeEach(() => {
    logger = createFakeLogger();
    bus = createBus(logger);
  });

  it("tryGetService returns undefined when absent, the impl when present", () => {
    const handle = defineService<{ n: number }>("registry/try-absent");
    expect(bus.tryGetService(handle)).toBeUndefined();

    const impl = { n: 1 };
    bus.provideService(handle, impl);
    expect(bus.tryGetService(handle)).toBe(impl);
  });

  it("tryGetService never throws (getService keeps throwing for mandatory deps)", () => {
    const handle = defineService<string>("registry/try-never-throws");
    expect(() => bus.tryGetService(handle)).not.toThrow();
    expect(bus.tryGetService(handle)).toBeUndefined();
    expect(() => bus.getService(handle)).toThrow("registry/try-never-throws");
  });

  it("onServiceAvailable fires immediately with the current impl when already provided", () => {
    const handle = defineService<string>("registry/late-join");
    bus.provideService(handle, "current");

    const seen: string[] = [];
    bus.onServiceAvailable(handle, (impl) => seen.push(impl));
    expect(seen).toEqual(["current"]);
  });

  it("onServiceAvailable fires on each later provide (and not when absent)", () => {
    const handle = defineService<number>("registry/later-provide");

    const seen: number[] = [];
    bus.onServiceAvailable(handle, (impl) => seen.push(impl));
    expect(seen).toEqual([]); // nothing provided yet → no fire

    const unprovide = bus.provideService(handle, 1);
    expect(seen).toEqual([1]);
    unprovide();
    bus.provideService(handle, 2);
    expect(seen).toEqual([1, 2]);
  });

  it("onServiceUnavailable fires when the un-provide disposer removes the service", () => {
    const handle = defineService<string>("registry/unavailable");

    const events: string[] = [];
    bus.onServiceUnavailable(handle, () => events.push("gone"));
    bus.onServiceAvailable(handle, (impl) => events.push(`got:${impl}`));

    const unprovide = bus.provideService(handle, "x");
    expect(events).toEqual(["got:x"]); // unavailable does NOT fire on provide
    unprovide();
    expect(events).toEqual(["got:x", "gone"]);
  });

  it("a stale un-provide disposer does NOT fire onServiceUnavailable", () => {
    const handle = defineService<string>("registry/stale-unavailable");

    const events: string[] = [];
    bus.onServiceUnavailable(handle, () => events.push("gone"));

    const stale = bus.provideService(handle, 1);
    stale(); // real removal → fires
    bus.provideService(handle, 2);
    stale(); // stale: must not evict the new one → no second fire
    expect(events).toEqual(["gone"]);
    expect(bus.getService(handle)).toBe(2);
  });

  it("subscriber callbacks are error-isolated and logged (never break the provider)", () => {
    const available = defineService<string>("registry/isolate-available");
    const unavailable = defineService<string>("registry/isolate-unavailable");
    const events: string[] = [];

    bus.onServiceAvailable(available, () => {
      throw new Error("available boom");
    });
    bus.onServiceAvailable(available, (impl) => events.push(`a:${impl}`));
    bus.onServiceUnavailable(unavailable, () => {
      throw new Error("unavailable boom");
    });

    // Provide: the throwing callback is logged, the sibling still runs,
    // and the service is registered.
    expect(() => bus.provideService(available, "v")).not.toThrow();
    expect(events).toEqual(["a:v"]);
    expect(bus.getService(available)).toBe("v");
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("registry/isolate-available");

    // Un-provide: same isolation on the unavailable path.
    const unprovide = bus.provideService(unavailable, "u");
    expect(() => unprovide()).not.toThrow();
    expect(bus.tryGetService(unavailable)).toBeUndefined();
    expect(logger.errors).toHaveLength(2);
    expect(logger.errors[1]?.message).toContain("registry/isolate-unavailable");
  });

  it("the immediate fire of onServiceAvailable is also error-isolated", () => {
    const handle = defineService<string>("registry/isolate-immediate");
    bus.provideService(handle, "v");

    expect(() =>
      bus.onServiceAvailable(handle, () => {
        throw new Error("late-join boom");
      }),
    ).not.toThrow();
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("registry/isolate-immediate");
  });

  it("disposers stop further notification (available and unavailable)", () => {
    const handle = defineService<number>("registry/dispose");

    // Sanity first: BEFORE disposing, both subscriptions fire.
    const seen: number[] = [];
    const offAvailable = bus.onServiceAvailable(handle, (impl) => seen.push(impl));
    const gone: string[] = [];
    const offUnavailable = bus.onServiceUnavailable(handle, () => gone.push("gone"));
    const unprovide = bus.provideService(handle, 1);
    expect(seen).toEqual([1]);
    unprovide();
    expect(gone).toEqual(["gone"]);

    // After disposing: neither fires anymore.
    offAvailable();
    offUnavailable();
    seen.length = 0;
    gone.length = 0;
    const unprovide2 = bus.provideService(handle, 2);
    expect(seen).toEqual([]);
    unprovide2();
    expect(gone).toEqual([]);
  });

  it("a callback that unsubscribes itself during notification is not re-fired for later provides", () => {
    const handle = defineService<number>("registry/self-unsub");

    const seen: number[] = [];
    const sub = bus.onServiceAvailable(handle, (impl) => {
      seen.push(impl);
      sub(); // unsubscribe during the notification itself
    });
    // Nothing provided yet → no fire.
    expect(seen).toEqual([]);

    const unprovide = bus.provideService(handle, 1);
    expect(seen).toEqual([1]); // fired, and self-unsubscribed mid-notification

    // A later provide (after un-provide) must not reach the removed callback.
    unprovide();
    bus.provideService(handle, 2);
    expect(seen).toEqual([1]);
  });
});

describe("pure functions", () => {
  describe("dispatchEventSync", () => {
    it("calls all handlers with the payload", () => {
      const logger = createFakeLogger();
      const received: number[] = [];

      dispatchEventSync(
        [
          (payload) => {
            received.push(payload);
          },
          (payload) => {
            received.push(payload * 2);
          },
        ],
        5,
        logger,
        "test",
      );

      expect(received).toEqual([5, 10]);
    });

    it("catches sync throws and logs them", () => {
      const logger = createFakeLogger();
      const received: number[] = [];

      dispatchEventSync(
        [
          () => {
            throw new Error("sync boom");
          },
          (payload) => {
            received.push(payload);
          },
        ],
        42,
        logger,
        "test/sync",
      );

      expect(received).toEqual([42]);
      expect(logger.errors).toHaveLength(1);
    });
  });

  describe("sortFilters", () => {
    it("sorts by priority ascending, then by order ascending", () => {
      const entries = [
        { fn: async (v: number) => v, priority: 10, order: 0 },
        { fn: async (v: number) => v, priority: -1, order: 1 },
        { fn: async (v: number) => v, priority: 10, order: 2 },
        { fn: async (v: number) => v, priority: 0, order: 3 },
      ];

      const sorted = sortFilters(entries);
      expect(sorted.map((e) => e.order)).toEqual([1, 3, 0, 2]);
    });

    it("preserves registration order when priorities are equal", () => {
      const entries = [
        { fn: async (v: string) => v, priority: 0, order: 0 },
        { fn: async (v: string) => v, priority: 0, order: 1 },
        { fn: async (v: string) => v, priority: 0, order: 2 },
      ];

      const sorted = sortFilters(entries);
      expect(sorted.map((e) => e.order)).toEqual([0, 1, 2]);
    });
  });

  describe("applyFilterChain", () => {
    it("applies filters in order", async () => {
      const logger = createFakeLogger();
      const result = await applyFilterChain([(v) => v + 1, (v) => v * 3], 2, logger, "test", false);
      expect(result).toBe(9);
    });

    it("fail-open skips the throwing filter", async () => {
      const logger = createFakeLogger();
      const result = await applyFilterChain(
        [
          (v) => v + 10,
          () => {
            throw new Error("skip me");
          },
          (v) => v + 1,
        ],
        0,
        logger,
        "test",
        false,
      );
      expect(result).toBe(11);
      expect(logger.errors).toHaveLength(1);
    });

    it("fail-closed throws on error", async () => {
      const logger = createFakeLogger();
      await expect(
        applyFilterChain(
          [
            () => {
              throw new Error("closed");
            },
          ],
          0,
          logger,
          "test",
          true,
        ),
      ).rejects.toThrow("closed");
    });
  });
});
