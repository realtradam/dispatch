import type { ProviderContract, ProviderEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import type { ConcurrencyLimiter } from "./concurrency-manager.js";
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
  acquireCalls: { providerId: string; conversationId: string; promptStartedAt: number }[];
  releaseCalls: number;
  rateLimitReports: string[];
} {
  const acquireCalls: { providerId: string; conversationId: string; promptStartedAt: number }[] =
    [];
  const releaseCalls: { count: number } = { count: 0 };
  const rateLimitReports: string[] = [];

  return {
    acquireCalls,
    get releaseCalls() {
      return releaseCalls.count;
    },
    rateLimitReports,
    acquire(providerId, conversationId, promptStartedAt) {
      acquireCalls.push({ providerId, conversationId, promptStartedAt });
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
  it("acquires a slot before streaming and releases after the stream completes", async () => {
    const provider = fakeProvider([
      { type: "text-delta", delta: "hello" },
      { type: "finish", reason: "stop" },
    ]);
    const limiter = recordingLimiter();

    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", 12345);

    const events: ProviderEvent[] = [];
    for await (const e of wrapped.stream([], [])) {
      events.push(e);
    }

    // Slot acquired before stream, released after.
    expect(limiter.acquireCalls).toEqual([
      { providerId: "test-provider", conversationId: "conv1", promptStartedAt: 12345 },
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
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", 0);

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
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", 0);

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
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", 0);

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
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", 0);

    expect(wrapped.id).toBe("my-provider");
    expect(wrapped.listModels).toBeDefined();
    const models = await wrapped.listModels?.();
    expect(models).toEqual([{ id: "model-1" }]);
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
    const wrapped = wrapProviderWithConcurrency(provider, limiter, "conv1", 0);

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
});
