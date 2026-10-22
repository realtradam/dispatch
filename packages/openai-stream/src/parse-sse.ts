import type { ProviderEvent, Usage } from "@dispatch/kernel";

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface SSEChunkDelta {
  content?: string;
  reasoning_content?: string | null;
  /** Alias some OpenAI-compatible providers use instead of `reasoning_content`. */
  reasoning?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface SSEChunkChoice {
  delta: SSEChunkDelta;
  finish_reason?: string | null;
  index: number;
}

interface SSEChunkUsageDetails {
  cached_tokens?: number;
}

interface SSEChunk {
  id?: string;
  choices?: SSEChunkChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    prompt_tokens_details?: SSEChunkUsageDetails;
    completion_tokens_details?: Record<string, unknown>;
  };
}

interface ParserState {
  toolCalls: Map<number, ToolCallAccumulator>;
  finished: boolean;
  done: boolean;
  usage?: Usage;
}

/** One parser per response; usage snapshots are retained until DONE or EOF. */
export function createSSEParser() {
  const state: ParserState = { toolCalls: new Map(), finished: false, done: false };
  let ended = false;
  return {
    get done() {
      return state.done;
    },
    push(line: string): ProviderEvent[] {
      return ended ? [] : parseLines([line], state);
    },
    end(): ProviderEvent[] {
      if (ended) return [];
      ended = true;
      const events: ProviderEvent[] = [];
      if (state.usage) events.push({ type: "usage", usage: state.usage });
      if (state.toolCalls.size > 0 || (!state.finished && !state.done)) {
        events.push({ type: "error", message: "stream ended prematurely", retryable: true });
      }
      return events;
    },
  };
}

export function parseSSELines(lines: readonly string[]): ProviderEvent[] {
  const parser = createSSEParser();
  const events: ProviderEvent[] = [];
  for (const line of lines) {
    events.push(...parser.push(line));
    if (parser.done) break;
  }
  return [...events, ...parser.end()];
}

function parseLines(lines: readonly string[], state: ParserState): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const { toolCalls } = state;

  for (const line of lines) {
    if (state.done) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      state.done = true;
      break;
    }

    let chunk: SSEChunk;
    try {
      chunk = JSON.parse(data) as SSEChunk;
    } catch {
      events.push({ type: "error", message: `Invalid JSON in SSE data: ${data}` });
      continue;
    }

    if (chunk.choices) {
      for (const choice of chunk.choices) {
        const delta = choice.delta;

        if (typeof delta.content === "string" && delta.content) {
          events.push({ type: "text-delta", delta: delta.content });
        }

        // `reasoning` is a fallback alias for `reasoning_content` used by some
        // OpenAI-compatible providers; it only applies when the standard field
        // is absent (not merely empty) so a provider sending both keeps the
        // standard field authoritative.
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          events.push({ type: "reasoning-delta", delta: reasoning });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
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
              // Timing-only marker: the model's tool-call output has begun
              // streaming (the complete call is emitted at finish).
              events.push({ type: "tool-call-start" });
            }
          }
        }

        if (choice.finish_reason) {
          state.finished = true;
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
            events.push({
              type: "tool-call",
              toolCallId: acc.id,
              toolName: acc.name,
              input,
            });
          }
          toolCalls.clear();
          events.push({ type: "finish", reason: choice.finish_reason });
        }
      }
    }

    if (chunk.usage) {
      const flat = chunk.usage.cache_read_tokens;
      const nested = chunk.usage.prompt_tokens_details?.cached_tokens;
      // Prefer flat cache_read_tokens when non-zero (canonical for Anthropic-style
      // providers). Some providers (LongCat) return cache_read_tokens:0 alongside
      // the real value in prompt_tokens_details.cached_tokens; `??` alone would
      // shadow it with 0. Fall back to nested when flat is 0/absent, then to flat.
      const cacheRead = flat || (nested ?? flat);
      const cacheWrite = chunk.usage.cache_write_tokens;
      state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
      };
    }
  }

  return events;
}
