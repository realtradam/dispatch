import type { ProviderStreamOptions, ReasoningEffort } from "@dispatch/kernel";

/** The `reasoning_effort` values CoralBricks accepts (`GET /v1/models`). */
export type CoralReasoningEffort = "low" | "high" | "max";

/**
 * Map a resolved `ReasoningEffort` to CoralBricks' `reasoning_effort` wire value.
 *
 * CoralBricks advertises three efforts — `low`, `high`, `max` — in its
 * `GET /v1/models` metadata. Dispatch's ladder adds `medium` and `xhigh`, so:
 * - `medium` → `high` (the middle of CoralBricks' three-level ladder),
 * - `xhigh` → `max` (the top of the ladder).
 *
 * An absent effort (`undefined`) maps to `undefined` so the caller emits no
 * `reasoning_effort` field at all — the provider then applies its own default
 * (`none`, per its model metadata), and the body stays byte-stable.
 *
 * Pure: the `transformBody` decision, factored out for direct unit testing.
 */
export function mapReasoningEffort(
  effort: ReasoningEffort | undefined,
): CoralReasoningEffort | undefined {
  switch (effort) {
    case undefined:
      return undefined;
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "max";
  }
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
