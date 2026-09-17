import type {
  ChatMessage,
  ProviderEvent,
  ProviderStreamOptions,
  Span,
  ToolContract,
} from "@dispatch/kernel";
import type { FetchLike, HttpExchangeFixture } from "@dispatch/trace-replay";
import {
  type BodyEvictionReport,
  byteLengthUtf8,
  DEFAULT_MAX_BODY_BYTES,
  enforceBodyBudget,
} from "./body-budget.js";
import { convertMessages, type OpenAIMessage } from "./convert-messages.js";
import { convertTools, type OpenAITool } from "./convert-tools.js";

export interface StreamConfig {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  /**
   * Internal injectable fetch — used by replay tests and record mode.
   * When absent, falls back to globalThis.fetch (production default).
   */
  readonly fetchFn?: FetchLike;
  /**
   * Optional hook a provider extension uses to add provider-specific body
   * fields (e.g. `reasoning_effort`) before the request is sent. Receives the
   * body built so far + the ProviderStreamOptions; returns ADDITIONAL fields
   * to merge into the body (or a full body). Generic — the library names no
   * feature. Applied AFTER building `body` and BEFORE `JSON.stringify`, so
   * the verbatim post-transform bytes are what hit the wire (and what the
   * provider.request span captures). Default (absent): no extra fields.
   */
  readonly transformBody?: (
    body: Record<string, unknown>,
    opts: ProviderStreamOptions,
  ) => Record<string, unknown>;
  /**
   * Maximum request-body size in UTF-8 bytes (default:
   * `DEFAULT_MAX_BODY_BYTES`, 9.5 MiB). When the serialized body exceeds this,
   * `streamChat` evicts the OLDEST inline image parts first (each replaced IN
   * PLACE by a placeholder text part) so the request stays under the
   * provider's body-size cap instead of being rejected with HTTP 400.
   */
  readonly maxBodyBytes?: number;
}

/**
 * Graduated secret mask — §6 tiers. Reimplemented locally (isolation-over-dry).
 * ≥13 → reveal 3 each side · 11–12 → 2 · 8–10 → 1 · ≤7 → full mask.
 */
function maskSecret(value: string): string {
  const len = value.length;
  if (len <= 7) return "…redacted…";
  let reveal: number;
  if (len >= 13) {
    reveal = 3;
  } else if (len >= 11) {
    reveal = 2;
  } else {
    reveal = 1;
  }
  return `${value.slice(0, reveal)}…redacted…${value.slice(-reveal)}`;
}

export async function* streamChat(
  config: StreamConfig,
  messages: readonly ChatMessage[],
  tools: readonly ToolContract[],
  opts?: ProviderStreamOptions,
): AsyncIterable<ProviderEvent> {
  const openaiMessages = convertMessages(messages);
  const openaiTools = convertTools(tools);

  const systemPrompt = opts?.systemPrompt;
  const finalMessages: OpenAIMessage[] = systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...openaiMessages]
    : openaiMessages;

  const body: Record<string, unknown> = {
    model: opts?.model ?? config.model,
    messages: finalMessages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (openaiTools.length > 0) {
    body.tools = openaiTools satisfies OpenAITool[];
  }
  if (opts?.temperature !== undefined) {
    body.temperature = opts.temperature;
  }
  if (opts?.maxTokens !== undefined) {
    body.max_tokens = opts.maxTokens;
  }

  if (config.transformBody) {
    const extra = config.transformBody(body, opts ?? {});
    Object.assign(body, extra);
  }

  const url = `${config.baseURL}/chat/completions`;
  let bodyString = JSON.stringify(body);

  // Provider body-size budget: inline images (`data:` URLs) dominate body
  // size. When the serialized body exceeds the budget, evict the oldest image
  // parts first (each replaced IN PLACE by a placeholder text part) so the
  // request stays under the provider's cap (charm gateway: 10 MiB) instead of
  // being rejected with HTTP 400 "invalid request body".
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const bodyBytesBefore = byteLengthUtf8(bodyString);
  let eviction: BodyEvictionReport | null = null;
  if (bodyBytesBefore > maxBodyBytes) {
    eviction = enforceBodyBudget(body, maxBodyBytes);
    bodyString = JSON.stringify(body);
  }

  // Already-aborted before any I/O starts: short-circuit so no request is sent.
  if (opts?.signal?.aborted) {
    return;
  }

  let reqSpan: Span | undefined;
  let totalInputTokens: number | undefined;
  let totalOutputTokens: number | undefined;
  let totalCacheReadTokens: number | undefined;
  let totalCacheWriteTokens: number | undefined;

  if (opts?.logger) {
    try {
      const model = opts?.model ?? config.model;
      const hasCacheBreakpoint = bodyString.includes("cache_control");
      const spanAttrs: Record<string, string | number | boolean | null> = {
        model,
        url,
        "request.method": "POST",
        "request.cache_control_present": hasCacheBreakpoint,
        "request.headers.authorization": `Bearer ${maskSecret(config.apiKey)}`,
      };
      if (eviction !== null && eviction.imagesEvicted > 0) {
        spanAttrs["request.images_evicted"] = eviction.imagesEvicted;
        spanAttrs["request.body_bytes_before"] = bodyBytesBefore;
        spanAttrs["request.body_budget_max_bytes"] = maxBodyBytes;
      }
      reqSpan = opts.logger.span("provider.request", spanAttrs, bodyString);
    } catch {
      // Fail-safe: capture must never break stream().
    }
  }

  let effectiveFetch: FetchLike = config.fetchFn ?? fetch;

  const recordPath =
    typeof process !== "undefined" ? process.env.DISPATCH_RECORD_FIXTURE : undefined;
  if (recordPath && !config.fetchFn) {
    try {
      const { recordFetch: rf, saveFixture } = await import("@dispatch/trace-replay");
      effectiveFetch = rf(effectiveFetch, (fx: HttpExchangeFixture) => {
        try {
          const redactedHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(fx.request.headers)) {
            if (key.toLowerCase() === "authorization") {
              const token = value.replace(/^Bearer\s+/i, "");
              redactedHeaders[key] = `Bearer ${maskSecret(token)}`;
            } else {
              redactedHeaders[key] = value;
            }
          }
          const redacted: HttpExchangeFixture = {
            request: { ...fx.request, headers: redactedHeaders },
            response: fx.response,
            ...(fx.meta !== undefined ? { meta: fx.meta } : {}),
          };
          saveFixture(recordPath, redacted);
        } catch {
          // Fail-safe: capture/write must never break the turn.
        }
      });
    } catch {
      // Fail-safe: dynamic import or wrapping failure must never break the turn.
    }
  }

  let response: Response;
  try {
    response = await effectiveFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: bodyString,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    // A deliberate stop aborts the fetch — this is cancellation, not a
    // retryable provider failure. Do not yield an error event (the kernel
    // barrier seals the turn as aborted).
    if (opts?.signal?.aborted) {
      if (reqSpan) {
        try {
          reqSpan.end({
            err: new Error("aborted"),
            attrs: { status: 0, aborted: true },
          });
        } catch {
          // Fail-safe.
        }
      }
      return;
    }
    if (reqSpan) {
      try {
        reqSpan.end({
          err,
          attrs: { status: 0 },
        });
      } catch {
        // Fail-safe.
      }
    }
    yield {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
    return;
  }

  if (!response.ok) {
    // If the signal aborts during the error-body read, treat it as
    // cancellation (skip the read + yield nothing) rather than a retryable
    // HTTP error.
    if (opts?.signal?.aborted) {
      if (reqSpan) {
        try {
          reqSpan.end({
            err: new Error("aborted"),
            attrs: { status: response.status, aborted: true },
          });
        } catch {
          // Fail-safe.
        }
      }
      return;
    }
    const text = await response.text().catch(() => "unknown");
    if (reqSpan) {
      try {
        reqSpan.setAttributes({ status: response.status });
        reqSpan.end({
          err: new Error(`HTTP ${response.status}: ${text}`),
          attrs: {
            status: response.status,
            "response.error_body": text,
          },
        });
      } catch {
        // Fail-safe.
      }
    }
    yield {
      type: "error",
      message: `HTTP ${response.status}: ${text}`,
      code: String(response.status),
      retryable: response.status >= 500 || response.status === 429,
    };
    return;
  }

  if (!response.body) {
    if (reqSpan) {
      try {
        reqSpan.end({
          err: new Error("Response body is null"),
          attrs: { status: response.status },
        });
      } catch {
        // Fail-safe.
      }
    }
    yield { type: "error", message: "Response body is null" };
    return;
  }

  try {
    yield* readSSEStream(
      response.body,
      (usage) => {
        totalInputTokens = usage.inputTokens;
        totalOutputTokens = usage.outputTokens;
        totalCacheReadTokens = usage.cacheReadTokens;
        totalCacheWriteTokens = usage.cacheWriteTokens;
      },
      opts?.signal,
    );
  } catch (err) {
    if (reqSpan) {
      try {
        reqSpan.end({
          err,
          attrs: { status: response.status },
        });
      } catch {
        // Fail-safe.
      }
    }
    throw err;
  }

  if (reqSpan) {
    try {
      const attrs: Record<string, string | number | boolean | null> = {
        status: response.status,
      };
      if (totalInputTokens !== undefined) {
        attrs["usage.inputTokens"] = totalInputTokens;
      }
      if (totalOutputTokens !== undefined) {
        attrs["usage.outputTokens"] = totalOutputTokens;
      }
      if (totalCacheReadTokens !== undefined) {
        attrs["usage.cacheReadTokens"] = totalCacheReadTokens;
      }
      if (totalCacheWriteTokens !== undefined) {
        attrs["usage.cacheWriteTokens"] = totalCacheWriteTokens;
      }
      reqSpan.end({ attrs });
    } catch {
      // Fail-safe.
    }
  }
}

async function* readSSEStream(
  body: ReadableStream<Uint8Array>,
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }) => void,
  signal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  try {
    while (true) {
      // Race each body read against the abort signal so a signal that fires
      // while read() is pending (or a provider that never sends more bytes)
      // can't keep the turn pending after Stop. Uses the same promise-coordination
      // technique as the kernel's abortableIteration (no I/O here beyond the
      // underlying read already in flight).
      type ReadResult = Awaited<ReturnType<typeof reader.read>>;
      const readPromise: Promise<ReadResult> = reader.read();
      let result: ReadResult;
      if (signal !== undefined) {
        result = await new Promise<ReadResult>((resolve) => {
          const onAbort = () => {
            // Best-effort cancel the reader; releaseLock is handled in finally.
            try {
              void reader.cancel().catch(() => {});
            } catch {
              // swallow
            }
            resolve({ done: true, value: undefined });
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          void readPromise.catch(() => {});
          signal.addEventListener("abort", onAbort, { once: true });
          void readPromise.then((r) => {
            signal.removeEventListener("abort", onAbort);
            resolve(r);
          });
        });
      } else {
        result = await readPromise;
      }
      const { done, value } = result;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data);
        } catch {
          yield { type: "error", message: `Invalid JSON in SSE data: ${data}` };
          continue;
        }

        const choices = chunk.choices as
          | Array<{
              delta: Record<string, unknown>;
              finish_reason?: string | null;
            }>
          | undefined;

        if (choices) {
          for (const choice of choices) {
            const delta = choice.delta;

            if (typeof delta.content === "string" && delta.content) {
              yield { type: "text-delta", delta: delta.content };
            }

            if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
              yield { type: "reasoning-delta", delta: delta.reasoning_content };
            }

            const tcs = delta.tool_calls as
              | Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>
              | undefined;

            if (tcs) {
              for (const tc of tcs) {
                const existing = toolCalls.get(tc.index);
                if (existing) {
                  if (tc.function?.arguments) {
                    existing.arguments += tc.function.arguments;
                  }
                } else {
                  toolCalls.set(tc.index, {
                    id: tc.id ?? "",
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? "",
                  });
                }
              }
            }

            if (choice.finish_reason) {
              const sortedIndices = [...toolCalls.keys()].sort((a, b) => a - b);
              for (const idx of sortedIndices) {
                const acc = toolCalls.get(idx);
                if (!acc) continue;
                let input: unknown;
                try {
                  input = JSON.parse(acc.arguments);
                } catch {
                  input = acc.arguments;
                }
                yield {
                  type: "tool-call",
                  toolCallId: acc.id,
                  toolName: acc.name,
                  input,
                };
              }
              yield { type: "finish", reason: choice.finish_reason };
            }
          }
        }

        const usage = chunk.usage as
          | {
              prompt_tokens?: number;
              completion_tokens?: number;
              cache_read_tokens?: number;
              cache_write_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              completion_tokens_details?: Record<string, unknown>;
            }
          | undefined;

        if (usage) {
          const flat = usage.cache_read_tokens;
          const nested = usage.prompt_tokens_details?.cached_tokens;
          // Prefer flat cache_read_tokens when non-zero (canonical for
          // Anthropic-style providers). Some providers (LongCat) return
          // cache_read_tokens:0 alongside the real value in
          // prompt_tokens_details.cached_tokens; `??` alone would shadow that
          // real value with 0 (0 is not nullish). Fall back to nested when flat
          // is 0/absent, then to flat (so an explicit 0 with no nested field is
          // preserved).
          const cacheRead = flat || (nested ?? flat);
          const cacheWrite = usage.cache_write_tokens;
          const usageObj: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          } = {
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
          };
          if (cacheRead !== undefined) {
            usageObj.cacheReadTokens = cacheRead;
          }
          if (cacheWrite !== undefined) {
            usageObj.cacheWriteTokens = cacheWrite;
          }
          onUsage?.(usageObj);
          yield {
            type: "usage",
            usage: {
              inputTokens: usage.prompt_tokens ?? 0,
              outputTokens: usage.completion_tokens ?? 0,
              ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
              ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
            },
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
