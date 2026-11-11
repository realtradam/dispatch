/**
 * Pure parsing/validation of the OpenCode credential from the process
 * environment.
 *
 * OpenCode is configured by ONE provider-specific environment variable:
 *
 *     OPENCODE_API_KEY=sk-...
 *
 * It registers a single provider + credential named `opencode`
 * ({@link OPENCODE_PROVIDER_ID}), so its models are addressed as
 * `opencode/<model>`. An unset or empty `OPENCODE_API_KEY` simply means
 * OpenCode is unavailable — that is not an error.
 *
 * Obsolete variables are never treated as a configuration fallback, and never
 * silently ignored — each one produces a secret-free
 * {@link OpenCodeEnvDiagnostic}:
 *
 *  - `OPENCODE_API_KEY_<n>` (the former numbered scheme, one provider per
 *    number) is IGNORED with a `legacy-numbered` WARNING. It is deliberately
 *    not fatal: a stale numbered key left behind in the env file must not stop
 *    the whole server from booting; it just configures nothing.
 *  - `DISPATCH_API_KEY` (the original single-key path) is REJECTED with a
 *    FATAL `legacy-dispatch` diagnostic, as before.
 *
 * Diagnostics carry only environment-key names + issue kinds — never, ever the
 * API-key values. {@link formatOpenCodeEnvDiagnostics} renders a secret-free
 * string that a config/bootstrap boundary uses either to abort startup (fatal
 * diagnostics, see {@link isFatalOpenCodeEnvDiagnostic}) or to log a warning.
 *
 * This is a PURE module (env → structured result, no I/O, no logging, no
 * ambient state) so it is exhaustively unit-testable.
 */

/** The validated OpenCode credential. */
export interface OpenCodeCredential {
  /** The secret API key. Never serialize/log it. */
  readonly apiKey: string;
  /** The OpenAI-compatible base URL the credential talks to. */
  readonly baseURL: string;
  /** The default model served when no explicit one is given. */
  readonly model: string;
}

/** A validation finding. Carries NO secret values. */
export interface OpenCodeEnvDiagnostic {
  /** The exact offending environment variable NAME. */
  readonly key: string;
  /** Why this entry was flagged. */
  readonly issue:
    | "legacy-numbered" // obsolete OPENCODE_API_KEY_<n> present — ignored (warning)
    | "legacy-dispatch"; // obsolete DISPATCH_API_KEY present — must be removed (fatal)
}

/** Result of parsing the environment. */
export interface ParseOpenCodeEnvResult {
  /** The validated credential, or null when OpenCode is not configured. */
  readonly credential: OpenCodeCredential | null;
  /** Validation findings (never include secret values), in a deterministic order. */
  readonly diagnostics: readonly OpenCodeEnvDiagnostic[];
}

/** The single OpenCode API-key variable. */
export const OPENCODE_API_KEY_VAR = "OPENCODE_API_KEY";

/** Prefix of the OBSOLETE numbered OpenCode API-key variables. */
export const LEGACY_NUMBERED_OPENCODE_API_KEY_PREFIX = "OPENCODE_API_KEY_";

/** The provider id AND credential name OpenCode registers under. */
export const OPENCODE_PROVIDER_ID = "opencode";

/** Default OpenAI-compatible base URL (mirrors openai-stream's default). */
export const DEFAULT_OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";

/** Default model when none is configured/provided. */
export const DEFAULT_OPENCODE_MODEL = "deepseek-v4.1-flash";

/**
 * Parse the OpenCode credential from an env map.
 *
 * @param env       The environment map (e.g. `process.env`).
 * @param opts      Optional defaults: `baseURL` (default
 *                  {@link DEFAULT_OPENCODE_BASE_URL}) and `model` (default
 *                  {@link DEFAULT_OPENCODE_MODEL}).
 */
export function parseOpenCodeEnv(
  env: Readonly<Record<string, string | undefined>>,
  opts: { readonly baseURL?: string; readonly model?: string } = {},
): ParseOpenCodeEnvResult {
  const baseURL = opts.baseURL ?? DEFAULT_OPENCODE_BASE_URL;
  const model = opts.model ?? DEFAULT_OPENCODE_MODEL;
  const diagnostics: OpenCodeEnvDiagnostic[] = [];

  // Obsolete numbered variables. Only ones that actually carry a value are
  // flagged (an empty one configures nothing, like any unset variable). Sorted
  // by name so the diagnostics are independent of env iteration order.
  const numbered = Object.keys(env)
    .filter((key) => {
      if (!key.startsWith(LEGACY_NUMBERED_OPENCODE_API_KEY_PREFIX)) return false;
      const value = env[key];
      return value !== undefined && value.length > 0;
    })
    .sort();
  for (const key of numbered) diagnostics.push({ key, issue: "legacy-numbered" });

  // Obsolete legacy single-key variable (the old openai-compat path). It is
  // not a fallback — reject loudly whenever it is present with a value.
  const legacyDispatch = env.DISPATCH_API_KEY;
  if (legacyDispatch !== undefined && legacyDispatch.length > 0) {
    diagnostics.push({ key: "DISPATCH_API_KEY", issue: "legacy-dispatch" });
  }

  // The value is kept exactly as given (never trimmed/normalized, which could
  // alter a real secret). Unset or empty → OpenCode is simply not configured.
  const apiKey = env[OPENCODE_API_KEY_VAR];
  const credential = apiKey !== undefined && apiKey.length > 0 ? { apiKey, baseURL, model } : null;

  return { credential, diagnostics };
}

/**
 * True for a diagnostic that must ABORT startup (the config boundary refuses to
 * boot); false for one that is only a warning (the offending variable is
 * ignored and the server boots normally).
 */
export function isFatalOpenCodeEnvDiagnostic(diagnostic: OpenCodeEnvDiagnostic): boolean {
  return diagnostic.issue === "legacy-dispatch";
}

/**
 * Render the given diagnostics as a single secret-free human-readable string
 * suitable for a fatal startup/config error or a warning. Only environment-key
 * names and issue kinds appear — never any API-key value. Returns `null` when
 * there is nothing to report.
 */
export function formatOpenCodeEnvDiagnostics(
  diagnostics: readonly OpenCodeEnvDiagnostic[],
): string | null {
  if (diagnostics.length === 0) return null;
  const lines: string[] = [];
  for (const d of diagnostics) {
    switch (d.issue) {
      case "legacy-numbered":
        lines.push(
          `${d.key}: obsolete numbered variable (ignored) — use ${OPENCODE_API_KEY_VAR} instead`,
        );
        break;
      case "legacy-dispatch":
        lines.push(`${d.key}: obsolete variable — use ${OPENCODE_API_KEY_VAR} instead`);
        break;
      default:
        lines.push(`${d.key}: unknown configuration issue`);
    }
  }
  return lines.join("; ");
}

/**
 * Returns true iff the given environment configures the OpenCode credential.
 * OpenCode is simply "unavailable" when this is false.
 */
export function hasOpenCodeCredential(env: Readonly<Record<string, string | undefined>>): boolean {
  return parseOpenCodeEnv(env).credential !== null;
}
