import { abortableIteration, type ProviderContract, type ProviderEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import type { ConcurrencyLimiter } from "./concurrency-manager.js";
import { ConcurrencyAcquireAbortedError, createConcurrencyManager } from "./concurrency-manager.js";
import { wrapProviderWithConcurrency } from "./provider-wrapper.js";

/** Build a fake provider that yields a sequence of events. */
function fakeProvider(events: ProviderEvent[]): ProviderContract {
  return {
    id: "test-provider",
    stream: async function* (): AsyncIterable<ProviderEvent> {
      for (const e of events) {
        yield e;
      }
    },
  };
}

/** A fake limiter that records acquire/release calls. */
function recordingLimiter(): ConcurrencyLimiter & {
  acquireCalls: {
    providerId: string;
    conversationId: string;
    workspaceId: string;
    promptStartedAt: number;
  }[];
  releaseCalls: number;
  rateLimitReports: string[];
} {
  const acquireCalls: {
    providerId: string;
    conversationId: string;
    workspaceId: string;
    promptStartedAt: number;
  }[] = [];
  const releaseCalls: { count: number } = { count: 0 };
  const rateLimitReports: string[] = [];

  return {
    acquireCalls,
    get releaseCalls() {
      return releaseCalls.count;
    },
    rateLimitReports,
    acquire(providerId, conversationId, workspaceId, promptStartedAt) {
      acquireCalls.push({ providerId, conversationId, workspaceId, promptStartedAt });
      return Promise.resolve(() => {
        releaseCalls.count++;
      });
    },
    reportRateLimit(providerId) {
      rateLimitReports.push(providerId);
    },
  };
}

describe("wrapProviderWithConcurrency", () => {
  it("releases a real limiter slot after Stop while suspended at yield", async () => {
    const limiter = createConcurrencyManager({
      now: Date.now,
      slotTimeoutMs: 300_000,
      watchdogIntervalMs: 60_000,
      defaultPauseMs: 1_000,
      releaseCooldownMs: 0,
    });
    const controller = new AbortController();
    const provider = fakeProvider([
      { type: "text-delta", delta: "first" },
      { type: "text-delta", delta: "must not be consumed" },
    ]);
    limiter.setLimit(provider.id, 1);
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);
    const iter = abortableIteration(
      wrapped.stream([], [], { signal: controller.signal })[Symbol.asyncIterator](),
      controller.signal,
    );
    try {
      expect(await iter.next()).toEqual({
        done: false,
        value: { type: "text-delta", delta: "first" },
      });
      expect(limiter.getStatus(provider.id)?.inFlight).toBe(1);

      controller.abort();
      expect(await iter.next()).toEqual({ done: true, value: undefined });
      // Drain generator-finalization microtasks without waiting for the watchdog.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(limiter.getStatus(provider.id)?.inFlight).toBe(0);
      expect(limiter.getStatus(provider.id)?.queued).toBe(0);
    } finally {
      await iter.return?.();
      limiter.destroy();
    }
  });

  it("acquires a slot before streaming and releases after the stream completes", async () => {
    const provider = fakeProvider([
      { type: "text-delta", delta: "hello" },
      { type: "finish", reason: "stop" },
    ]);
    const limiter = recordingLimiter();

    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 12345);

    const events: ProviderEvent[] = [];
    for await (const e of wrapped.stream([], [])) {
      events.push(e);
    }

    // Slot acquired before stream, released after.
    expect(limiter.acquireCalls).toEqual([
      {
        providerId: "test-provider",
        conversationId: "conv1",
        workspaceId: "default",
        promptStartedAt: 12345,
      },
    ]);
    expect(limiter.releaseCalls).toBe(1);
    expect(events).toEqual([
      { type: "text-delta", delta: "hello" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("releases the slot even when the stream throws", async () => {
    const provider: ProviderContract = {
      id: "err-provider",
      stream: async function* (): AsyncIterable<ProviderEvent> {
        yield { type: "text-delta", delta: "partial" };
        throw new Error("stream exploded");
      },
    };
    const limiter = recordingLimiter();
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);

    await expect(async () => {
      for await (const _e of wrapped.stream([], [])) {
        // consume
      }
    }).rejects.toThrow("stream exploded");

    expect(limiter.releaseCalls).toBe(1);
  });

  it("reports 429 errors to the limiter", async () => {
    const provider = fakeProvider([
      { type: "error", message: "Too many requests", code: "429", retryable: true },
    ]);
    const limiter = recordingLimiter();
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);

    const events: ProviderEvent[] = [];
    for await (const e of wrapped.stream([], [])) {
      events.push(e);
    }

    expect(limiter.rateLimitReports).toEqual(["test-provider"]);
    // The 429 error event is still yielded to the consumer (kernel handles retry).
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("does not report non-429 errors", async () => {
    const provider = fakeProvider([
      { type: "error", message: "Internal error", code: "500", retryable: true },
    ]);
    const limiter = recordingLimiter();
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);

    for await (const _e of wrapped.stream([], [])) {
      // consume
    }

    expect(limiter.rateLimitReports).toEqual([]);
  });

  it("preserves the provider id and listModels", async () => {
    const provider: ProviderContract = {
      id: "my-provider",
      stream: async function* (): AsyncIterable<ProviderEvent> {
        yield { type: "finish", reason: "stop" };
      },
      listModels: async () => [{ id: "model-1" }],
    };
    const limiter = recordingLimiter();
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);

    expect(wrapped.id).toBe("my-provider");
    expect(wrapped.listModels).toBeDefined();
    const models = await wrapped.listModels?.();
    expect(models).toEqual([{ id: "model-1" }]);
  });

  it("preserves the provider's getUsage method (usage gate must survive wrapping)", async () => {
    const provider: ProviderContract = {
      id: "usage-provider",
      stream: async function* (): AsyncIterable<ProviderEvent> {
        yield { type: "finish", reason: "stop" };
      },
      getUsage: async () => ({ concurrentSessions: 2 }),
    };
    const limiter = recordingLimiter();
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);

    expect(wrapped.getUsage).toBeDefined();
    const usage = await wrapped.getUsage?.();
    expect(usage).toEqual({ concurrentSessions: 2 });
  });

  it("does NOT define getUsage when the inner provider has none", async () => {
    const provider = fakeProvider([{ type: "finish", reason: "stop" }]);
    const limiter = recordingLimiter();
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);
    expect(wrapped.getUsage).toBeUndefined();
  });

  it("calls onQueued when the request blocks and onAcquired when the slot is granted", async () => {
    let queuedCalled = false;
    let acquiredCalled = false;

    const blockingLimiter: ConcurrencyLimiter = {
      acquire(_providerId, _convId, _wsId, _promptAt, onQueued) {
        // Simulate a queued request: call onQueued, then resolve on next tick.
        onQueued?.();
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(() => {});
          }, 0);
        });
      },
      reportRateLimit() {},
    };

    const provider = fakeProvider([{ type: "finish", reason: "stop" }]);
    const wrapped = wrapProviderWithConcurrency(
      provider,
      blockingLimiter,
      "conv1",
      "default",
      0,
      () => {
        queuedCalled = true;
      },
      () => {
        acquiredCalled = true;
      },
    );

    for await (const _e of wrapped.stream([], [])) {
      // consume
    }

    expect(queuedCalled).toBe(true);
    expect(acquiredCalled).toBe(true);
  });

  it("does NOT call onQueued when the slot is granted immediately", async () => {
    let queuedCalled = false;
    let acquiredCalled = false;

    const immediateLimiter: ConcurrencyLimiter = {
      acquire(_providerId, _convId, _wsId, _promptAt, _onQueued) {
        // Grant immediately — do NOT call onQueued.
        return Promise.resolve(() => {});
      },
      reportRateLimit() {},
    };

    const provider = fakeProvider([{ type: "finish", reason: "stop" }]);
    const wrapped = wrapProviderWithConcurrency(
      provider,
      immediateLimiter,
      "conv1",
      "default",
      0,
      () => {
        queuedCalled = true;
      },
      () => {
        acquiredCalled = true;
      },
    );

    for await (const _e of wrapped.stream([], [])) {
      // consume
    }

    expect(queuedCalled).toBe(false);
    expect(acquiredCalled).toBe(true);
  });

  it("passes through messages, tools, and opts to the inner stream", async () => {
    let receivedArgs:
      | {
          messages: unknown;
          tools: unknown;
          opts: unknown;
        }
      | undefined;

    const provider: ProviderContract = {
      id: "passthrough",
      stream: async function* (messages, tools, opts): AsyncIterable<ProviderEvent> {
        receivedArgs = { messages, tools, opts };
        yield { type: "finish", reason: "stop" };
      },
    };
    const limiter = recordingLimiter();
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);

    const messages = [{ role: "user" as const, chunks: [{ type: "text" as const, text: "hi" }] }];
    const tools = [{ name: "test_tool", description: "test", parameters: {} }];
    const opts = { model: "gpt-4" };

    for await (const _e of wrapped.stream(messages, tools, opts)) {
      // consume
    }

    expect(receivedArgs?.messages).toBe(messages);
    expect(receivedArgs?.tools).toBe(tools);
    expect(receivedArgs?.opts).toBe(opts);
  });

  it("forwards opts.signal to acquire and yields no events when already aborted", async () => {
    let acquireSignal: AbortSignal | undefined;
    const ac = new AbortController();
    ac.abort();
    const limiter: ConcurrencyLimiter = {
      acquire(_providerId, _convId, _wsId, _promptAt, _onQueued, signal) {
        acquireSignal = signal;
        return Promise.resolve(() => {});
      },
      reportRateLimit() {},
    };
    const provider = fakeProvider([
      { type: "text-delta", delta: "should not appear" },
      { type: "finish", reason: "stop" },
    ]);
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);

    const events: ProviderEvent[] = [];
    for await (const e of wrapped.stream([], [], { signal: ac.signal })) {
      events.push(e);
    }
    expect(acquireSignal).toBe(ac.signal);
    expect(events).toHaveLength(0);
  });

  it("never starts the inner provider and does not call onAcquired when acquisition is cancelled", async () => {
    let innerCalls = 0;
    let onAcquiredCalled = false;
    const ac = new AbortController();
    const limiter: ConcurrencyLimiter = {
      acquire() {
        ac.abort(); // simulate the signal firing while queued
        return Promise.reject(new ConcurrencyAcquireAbortedError());
      },
      reportRateLimit() {},
    };
    const provider: ProviderContract = {
      id: "inner",
      stream: async function* (): AsyncIterable<ProviderEvent> {
        innerCalls++;
        yield { type: "finish", reason: "stop" };
      },
    };
    const wrapped = wrapProviderWithConcurrency(
      provider,
      limiter,
      "conv1",
      "default",
      0,
      undefined,
      () => {
        onAcquiredCalled = true;
      },
    );

    const events: ProviderEvent[] = [];
    for await (const e of wrapped.stream([], [], { signal: ac.signal })) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
    expect(innerCalls).toBe(0);
    expect(onAcquiredCalled).toBe(false);
  });

  it("releases immediately when the signal aborts between grant and stream start", async () => {
    let releaseCalls = 0;
    let innerCalls = 0;
    const ac = new AbortController();
    const limiter: ConcurrencyLimiter = {
      acquire() {
        // Grant the slot, then abort before the inner stream starts.
        const release = () => {
          releaseCalls++;
        };
        queueMicrotask(() => ac.abort());
        return Promise.resolve(release);
      },
      reportRateLimit() {},
    };
    const provider: ProviderContract = {
      id: "inner",
      stream: async function* (): AsyncIterable<ProviderEvent> {
        innerCalls++;
        yield { type: "finish", reason: "stop" };
      },
    };
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", "default", 0);

    const events: ProviderEvent[] = [];
    for await (const e of wrapped.stream([], [], { signal: ac.signal })) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
    expect(innerCalls).toBe(0);
    expect(releaseCalls).toBe(1);
  });
});
