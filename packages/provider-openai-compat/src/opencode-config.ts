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
 * There is deliberately NO unnumbered `OPENCODE_API_KEY` and NO legacy
 * `DISPATCH_API_KEY` path — this module rejects/handles them and reports
 * diagnostics, but NEVER falls back to them. OpenCode is unavailable when no
 * numbered keys are configured.
 *
 * Secrets are NEVER leaked: diagnostics carry only environment-key names and
 * issue kinds — never the API-key values themselves (not even to say two keys
 * are equal). The dedup of duplicate secret values compares values internally
 * and reports only the offending numbers.
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
    | "noncanonical" // suffix has a leading zero / noncanonical integer form
    | "zero" // suffix was literally "0" (must be positive)
    | "empty" // value is empty/missing → no usable key
    | "duplicate"; // value duplicates an earlier numbered key's value
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

  // The suffix must be ALL DIGITS for the variable to be a candidate OpenCode
  // key at all. A non-digit suffix (e.g. `OPENCODE_API_KEY_foo`) is simply not
  // an OpenCode variable — it is silently ignored (never "supported").
  const suffixRe = /^([0-9]+)$/;

  // Collect raw valid-digit entries keyed by their numeric suffix so we can
  // detect duplicates by value AFTER sorting.
  const found: { number: number; key: string; value: string }[] = [];
  const diagnostics: OpenCodeEnvDiagnostic[] = [];

  for (const key of Object.keys(env)) {
    if (!key.startsWith(OPENCODE_API_KEY_PREFIX)) continue;
    const suffix = key.slice(OPENCODE_API_KEY_PREFIX.length);
    const match = suffixRe.exec(suffix);
    if (match === null) continue; // not an all-digits suffix → not an OpenCode numbered key

    const digits = match[1] ?? "";
    // Canonical form: no leading zero unless the number is just "0".
    if (digits.length > 1 && digits.startsWith("0")) {
      diagnostics.push({ key, issue: "noncanonical" });
      continue;
    }
    if (digits === "0") {
      diagnostics.push({ key, issue: "zero" });
      continue;
    }

    const value = env[key];
    if (value === undefined || value.length === 0) {
      diagnostics.push({ key, issue: "empty" });
      continue;
    }

    const number = Number(digits);
    if (!Number.isSafeInteger(number) || number <= 0) {
      diagnostics.push({ key, issue: "noncanonical" });
      continue;
    }

    found.push({ number, key, value });
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
 * Returns true iff the given environment configures at least one numbered
 * OpenCode credential. OpenCode is simply "unavailable" when this is false.
 */
export function hasNumberedOpenCodeCredentials(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return parseNumberedOpenCodeEnv(env).credentials.length > 0;
}
