/**
 * window-keeper profiles — the provider-specific knowledge: which account-usage
 * row to watch, which response header carries the window reset, which model to
 * kick with, and what stream options the kick sends.
 *
 * The keeper itself is provider-agnostic; it consumes one of these profiles.
 */

export type KeeperProviderId = "claude" | "codex";

export interface KeeperProfile {
  readonly id: KeeperProviderId;
  /** Human label; also the Settings toggle label. */
  readonly label: string;
  /** Kernel provider id the kick is sent through. */
  readonly providerId: string;
  /** Auth id whose response headers belong to this provider. */
  readonly authId: string;
  /** The account-usage limit row this keeper watches. */
  readonly limitId: string;
  /** End of the running window (server time, ms) from response headers, or null. */
  readonly parseReset: (
    headers: Readonly<Record<string, string>>,
    serverNow: number,
  ) => number | null;
  /** Model for the kick; undefined = the provider's default model. */
  readonly pickModel: (ids: readonly string[]) => string | undefined;
  /**
   * Stream options of the kick (model and signal are added by the shell). There is
   * deliberately no output-token cap: a 1-token-capped request returns 200 but does
   * not start the usage window, so the kick is a normal "hi" the model answers fully.
   */
  readonly streamOptions: {
    readonly reasoningEffort?: "low";
    readonly systemPrompt?: string;
  };
}

/** End of the Claude 5-hour window from `anthropic-ratelimit-unified-5h-reset`. */
export const CLAUDE_PROFILE: KeeperProfile = {
  id: "claude",
  label: "Claude",
  providerId: "anthropic",
  authId: "claude-oauth",
  limitId: "claude:5h",
  parseReset: (headers) => {
    const ms = Number(headers["anthropic-ratelimit-unified-5h-reset"]) * 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  },
  pickModel: (ids) => ids.find((id) => id.includes("haiku")),
  streamOptions: {},
};

/** Codex's placeholder for "no such window": a non-positive window length. */
const CODEX_WINDOW_MINUTES_HEADER = "x-codex-primary-window-minutes";
const CODEX_RESET_AT_HEADER = "x-codex-primary-reset-at";
const CODEX_RESET_AFTER_HEADER = "x-codex-primary-reset-after-seconds";

/** End of the Codex primary window from the `x-codex-primary-*` headers. */
export const CODEX_PROFILE: KeeperProfile = {
  id: "codex",
  label: "Codex",
  providerId: "openai",
  authId: "codex-oauth",
  limitId: "codex:primary",
  parseReset: (headers, serverNow) => {
    const rawMinutes = headers[CODEX_WINDOW_MINUTES_HEADER];
    const minutes = Number(rawMinutes);
    if (rawMinutes !== undefined && Number.isFinite(minutes) && minutes <= 0) {
      return null;
    }
    const rawResetAt = headers[CODEX_RESET_AT_HEADER];
    const resetAt = Number(rawResetAt);
    if (rawResetAt !== undefined && Number.isFinite(resetAt) && resetAt > 0) {
      return resetAt < 1_000_000_000_000 ? resetAt * 1000 : resetAt;
    }
    const rawAfter = headers[CODEX_RESET_AFTER_HEADER];
    const after = Number(rawAfter);
    if (rawAfter !== undefined && Number.isFinite(after) && after >= 0) {
      return serverNow + after * 1000;
    }
    return null;
  },
  pickModel: () => undefined,
  streamOptions: { reasoningEffort: "low", systemPrompt: "Reply with the single word OK." },
};

/** Fixed order: claude, codex. */
export const KEEPER_PROFILES: readonly KeeperProfile[] = [CLAUDE_PROFILE, CODEX_PROFILE];
