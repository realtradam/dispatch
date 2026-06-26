import type { ProviderStreamOptions, ReasoningEffort } from "@dispatch/kernel";

/**
 * Map a resolved `ReasoningEffort` to Umans' `reasoning_effort` wire value.
 *
 * Umans' OpenAI route accepts `"none"|"low"|"medium"|"high"`; Dispatch's
 * `ReasoningEffort` adds `"xhigh"|"max"`, which Umans caps to `"high"`. An
 * absent effort (`undefined`) maps to `undefined` so the caller emits no
 * `reasoning_effort` field at all — byte-stable when the caller has no
 * preference.
 *
 * Pure: the `transformBody` decision, factored out for direct unit testing.
 */
export function mapReasoningEffort(
  effort: ReasoningEffort | undefined,
): "low" | "medium" | "high" | undefined {
  if (effort === undefined) return undefined;
  if (effort === "xhigh" || effort === "max") return "high";
  return effort;
}

/**
 * Provider-specific body transform handed to `@dispatch/openai-stream`'s
 * `createOpenAICompatProvider`. Returns the extra fields the library merges
 * into the chat-completions body before send. Adds `reasoning_effort` only when
 * a resolved effort is present; returns `{}` (no fields) otherwise —
 * byte-stable for calls with no reasoning preference.
 */
export function transformBody(
  _body: Record<string, unknown>,
  opts: ProviderStreamOptions,
): Record<string, unknown> {
  const mapped = mapReasoningEffort(opts.reasoningEffort);
  if (mapped === undefined) return {};
  return { reasoning_effort: mapped };
}
