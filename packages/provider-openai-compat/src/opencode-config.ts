/**
 * Pure parsing/validation of NUMBERED OpenCode credentials from the process
 * environment.
 *
 * OpenCode is configured EXCLUSIVELY via numbered provider-specific environment
 * variables:
 *
 *     OPENCODE_API_KEY_1=sk-...
 *     OPENCODE_API_KEY_2=sk-...
 *     OPENCODE_API_KEY_10=sk-...   (numeric sort, gaps allowed)
 *
 * Validation is STRICT and secret-free (see {@link OpenCodeEnvDiagnostic}):
 *
 *  - A variable whose name begins `OPENCODE_API_KEY_` MUST have a canonical
 *    positive-integer suffix (`[1-9][0-9]*`). Suffixes that are `0`, leading-
 *    zero (`01`), nonnumeric/mixed (`foo`, `1a`), empty, or carry trailing
 *    whitespace are REJECTED with a diagnostic — they are never silently
 *    ignored.
 *  - Legacy variables `DISPATCH_API_KEY` and the unnumbered `OPENCODE_API_KEY`
 *    are obsolete and are REJECTED with a diagnostic. They are never silently
 *    ignored and never treated as a configuration fallback.
 *
 * Diagnostics carry only environment-key names + issue kinds — never, ever the
 * API-key values (not even to say two keys are equal). The dedup of duplicate
 * secret values compares values internally and reports only the offending
 * numbers. {@link formatOpenCodeEnvDiagnostics} renders a secret-free fatal
 * string that a config/bootstrap boundary uses to abort startup deterministically
 * rather than booting with a partial or invalid credential set.
 *
 * This is a PURE module (env → structured result, no I/O, no logging, no
 * ambient state) so it is exhaustively unit-testable.
 */

/** A single validated numbered OpenCode credential. */
export interface OpenCodeNumberedCredential {
  /** The canonical positive integer from `OPENCODE_API_KEY_<N>`. Stable identity. */
  readonly number: number;
  /** The secret API key for this number. Never serialize/log it. */
  readonly apiKey: string;
  /** The OpenAI-compatible base URL this numbered credential talks to. */
  readonly baseURL: string;
  /** The default model this numbered credential serves when no explicit one is given. */
  readonly model: string;
}

/** A non-destructive validation finding. Carries NO secret values. */
export interface OpenCodeEnvDiagnostic {
  /** The exact offending environment variable NAME (`OPENCODE_API_KEY_...`). */
  readonly key: string;
  /** Why this entry was rejected/flagged. */
  readonly issue:
    | "noncanonical" // suffix is not a canonical `[1-9][0-9]*` integer (leading zero, non-digit/mixed, trailing-space, empty)
    | "zero" // suffix was literally "0" (must be positive)
    | "empty" // value is empty/missing → no usable key
    | "duplicate" // value duplicates an earlier numbered key's value
    | "legacy-dispatch" // obsolete DISPATCH_API_KEY present — must be removed
    | "legacy-unnumbered"; // obsolete unnumbered OPENCODE_API_KEY present — must be removed
  /** For `duplicate`: the number of the FIRST entry sharing this value. */
  readonly duplicateOf?: number;
}

/** Result of parsing the environment. */
export interface ParseNumberedOpenCodeEnvResult {
  /** Validated credentials, sorted numerically ascending (gaps preserved). */
  readonly credentials: readonly OpenCodeNumberedCredential[];
  /** Validation findings (never include secret values). */
  readonly diagnostics: readonly OpenCodeEnvDiagnostic[];
}

/** Prefix for numbered OpenCode API-key variables. */
export const OPENCODE_API_KEY_PREFIX = "OPENCODE_API_KEY_";

/** Default OpenAI-compatible base URL (mirrors openai-stream's default). */
export const DEFAULT_OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";

/** Default model when none is configured/provided. */
export const DEFAULT_OPENCODE_MODEL = "deepseek-v4-flash";

/**
 * Parse numbered OpenCode credentials from an env map.
 *
 * @param env       The environment map (e.g. `process.env`).
 * @param opts      Optional shared defaults: `baseURL` (default
 *                  {@link DEFAULT_OPENCODE_BASE_URL}) and `model` (default
 *                  {@link DEFAULT_OPENCODE_MODEL}) applied to EVERY numbered
 *                  credential.
 */
export function parseNumberedOpenCodeEnv(
  env: Readonly<Record<string, string | undefined>>,
  opts: { readonly baseURL?: string; readonly model?: string } = {},
): ParseNumberedOpenCodeEnvResult {
  const baseURL = opts.baseURL ?? DEFAULT_OPENCODE_BASE_URL;
  const model = opts.model ?? DEFAULT_OPENCODE_MODEL;

  // The ONLY canonical positive-integer suffix form recognised for a numbered
  // OpenCode key is `[1-9][0-9]*` — no `0`, no leading zeros, no non-digit or
  // mixed content, no trailing garbage/whitespace.
  const canonicalRe = /^[1-9][0-9]*$/;

  // Collect raw valid-digit entries keyed by their numeric suffix so we can
  // detect duplicates by value AFTER sorting.
  const found: { number: number; key: string; value: string }[] = [];
  const diagnostics: OpenCodeEnvDiagnostic[] = [];

  for (const key of Object.keys(env)) {
    if (key === "OPENCODE_API_KEY") {
      // Obsolete unnumbered variable. It is NOT a fallback — reject loudly.
      diagnostics.push({ key, issue: "legacy-unnumbered" });
      continue;
    }
    if (!key.startsWith(OPENCODE_API_KEY_PREFIX)) continue;

    const suffix = key.slice(OPENCODE_API_KEY_PREFIX.length);
    if (suffix === "0") {
      // Explicit zero suffix — reject as non-positive (distinct issue).
      diagnostics.push({ key, issue: "zero" });
      continue;
    }
    if (!canonicalRe.test(suffix)) {
      // Any other non-canonical suffix: `01`, `foo`, `1a`, empty, trailing
      // space, etc. NEVER silently ignored — flag for a deterministic failure.
      diagnostics.push({ key, issue: "noncanonical" });
      continue;
    }

    const value = env[key];
    if (value === undefined || value.length === 0) {
      diagnostics.push({ key, issue: "empty" });
      continue;
    }

    found.push({ number: Number(suffix), key, value });
  }

  // Obsolete legacy single-key variable (the old openai-compat path). It is
  // not a fallback — reject loudly whenever it is present with a value.
  const legacyDispatch = env.DISPATCH_API_KEY;
  if (legacyDispatch !== undefined && legacyDispatch.length > 0) {
    diagnostics.push({ key: "DISPATCH_API_KEY", issue: "legacy-dispatch" });
  }

  // Sort numerically ASCENDING by number (gaps preserved).
  found.sort((a, b) => a.number - b.number);

  // Detect duplicate secret VALUES (compare internally; report only numbers).
  const valueToFirstNumber = new Map<string, number>();
  const credentials: OpenCodeNumberedCredential[] = [];
  for (const entry of found) {
    const prior = valueToFirstNumber.get(entry.value);
    if (prior !== undefined) {
      diagnostics.push({ key: entry.key, issue: "duplicate", duplicateOf: prior });
      // Skip the duplicate numbered credential entirely — it is a misconfiguration
      // (two different numbers sharing one secret). The FIRST numbered entry is kept.
      continue;
    }
    valueToFirstNumber.set(entry.value, entry.number);
    credentials.push({ number: entry.number, apiKey: entry.value, baseURL, model });
  }

  return { credentials, diagnostics };
}

/**
 * Render the given diagnostics as a single secret-free human-readable string
 * suitable for a fatal startup/config error. Only environment-key names and
 * issue kinds appear — never any API-key value. Returns `null` when there is
 * nothing to report.
 */
export function formatOpenCodeEnvDiagnostics(
  diagnostics: readonly OpenCodeEnvDiagnostic[],
): string | null {
  if (diagnostics.length === 0) return null;
  const lines: string[] = [];
  for (const d of diagnostics) {
    switch (d.issue) {
      case "noncanonical":
        lines.push(`${d.key}: invalid suffix (must be a canonical [1-9][0-9]* integer)`);
        break;
      case "zero":
        lines.push(`${d.key}: suffix must be a positive integer (not 0)`);
        break;
      case "empty":
        lines.push(`${d.key}: empty value (no usable key)`);
        break;
      case "duplicate":
        lines.push(
          `${d.key}: same secret as OPENCODE_API_KEY_${d.duplicateOf ?? "?"} (duplicate key)`,
        );
        break;
      case "legacy-dispatch":
        lines.push(`${d.key}: obsolete variable — use numbered OPENCODE_API_KEY_<n> instead`);
        break;
      case "legacy-unnumbered":
        lines.push(`${d.key}: obsolete unnumbered variable — use OPENCODE_API_KEY_<n> instead`);
        break;
      default:
        lines.push(`${d.key}: unknown configuration issue`);
    }
  }
  return lines.join("; ");
}

/**
 * Returns true iff the given environment configures at least one numbered
 * OpenCode credential. OpenCode is simply "unavailable" when this is false.
 */
export function hasNumberedOpenCodeCredentials(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return parseNumberedOpenCodeEnv(env).credentials.length > 0;
}
