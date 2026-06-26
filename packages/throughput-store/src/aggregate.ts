/**
 * Pure throughput aggregation.
 *
 * Per model, tokens-per-second is the TOKEN-WEIGHTED average:
 *
 *     tok/s = Σ(output_tokens) / Σ(generation_seconds)
 *
 * i.e. total tokens over total generation time across the period's turns. This
 * makes a turn that generated more tokens count proportionally more than a small
 * turn — large turns dominate, exactly as intended. Generation time is the pure
 * decode time (excludes tool-execution waits).
 */

export interface ThroughputSample {
  readonly model: string;
  /** Epoch-ms the turn completed. */
  readonly ts: number;
  /** Output tokens generated in the turn. */
  readonly outputTokens: number;
  /** Pure generation time for the turn (ms), summed across its steps. */
  readonly genMs: number;
}

export interface ModelThroughput {
  readonly model: string;
  /** Token-weighted average tokens/second over the period. */
  readonly tokensPerSecond: number;
  readonly totalOutputTokens: number;
  readonly totalGenMs: number;
  /** Number of turns that contributed. */
  readonly turns: number;
}

/**
 * Aggregate samples within the half-open range `[start, end)` into per-model
 * throughput, sorted by tok/s descending (ties broken by model name).
 */
export function aggregateSamples(
  samples: readonly ThroughputSample[],
  start: number,
  end: number,
): ModelThroughput[] {
  const byModel = new Map<string, { tokens: number; genMs: number; turns: number }>();

  for (const s of samples) {
    if (s.ts < start || s.ts >= end) continue;
    const acc = byModel.get(s.model) ?? { tokens: 0, genMs: 0, turns: 0 };
    acc.tokens += s.outputTokens;
    acc.genMs += s.genMs;
    acc.turns += 1;
    byModel.set(s.model, acc);
  }

  const result: ModelThroughput[] = [];
  for (const [model, acc] of byModel) {
    const tokensPerSecond = acc.genMs > 0 ? round2(acc.tokens / (acc.genMs / 1000)) : 0;
    result.push({
      model,
      tokensPerSecond,
      totalOutputTokens: acc.tokens,
      totalGenMs: acc.genMs,
      turns: acc.turns,
    });
  }

  result.sort((a, b) => b.tokensPerSecond - a.tokensPerSecond || a.model.localeCompare(b.model));
  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
