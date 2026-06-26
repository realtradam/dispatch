import type {
  ChatMessage,
  ProviderContract,
  ProviderEvent,
  ProviderStreamOptions,
  ToolContract,
} from "@dispatch/kernel";
import type { ConcurrencyLimiter } from "./concurrency-manager.js";

/**
 * Wrap a provider's `stream` method with concurrency limiting.
 *
 * A slot is acquired BEFORE the first event is yielded (before the HTTP
 * request is sent — the `await limiter.acquire()` runs before the generator
 * body starts iterating the inner stream). The slot is released in a `finally`
 * block AFTER the inner stream completes (the full response stream, not just
 * HTTP headers — matching the Umans concurrency model where a slot is held
 * only while tokens are actually generating).
 *
 * 429 detection: if the provider yields an `error` event with `code: "429"`,
 * the limiter is notified so it can pause the queue for that provider.
 *
 * @param provider         The underlying provider to wrap.
 * @param limiter          The concurrency limiter (acquire/release/reportRateLimit).
 * @param conversationId   The agent requesting the stream (for slot attribution).
 * @param promptStartedAt  When the agent's current prompt (turn) started
 *                         (epoch-ms, for oldest-agent-first scheduling).
 */
export function wrapProviderWithConcurrency(
  provider: ProviderContract,
  limiter: ConcurrencyLimiter,
  conversationId: string,
  promptStartedAt: number,
): ProviderContract {
  const innerStream = provider.stream;
  const providerId = provider.id;

  return {
    id: provider.id,
    stream: async function* (
      messages: readonly ChatMessage[],
      tools: readonly ToolContract[],
      opts?: ProviderStreamOptions,
    ): AsyncIterable<ProviderEvent> {
      const release = await limiter.acquire(providerId, conversationId, promptStartedAt);
      try {
        for await (const event of innerStream(messages, tools, opts)) {
          if (event.type === "error" && event.code === "429") {
            limiter.reportRateLimit(providerId);
          }
          yield event;
        }
      } finally {
        release();
      }
    },
    ...(provider.listModels !== undefined ? { listModels: provider.listModels } : {}),
  };
}
