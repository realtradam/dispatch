/**
 * Auth contract — how a provider obtains credentials.
 *
 * Kept minimal and general. The common case is API-key + base-URL; richer
 * flows (OAuth, token refresh) are handled by specific auth extensions that
 * still resolve to credentials the provider can consume.
 */

/**
 * The simplest credential set: an API key and optional base URL.
 * This is the common case for OpenAI-compatible and most provider extensions.
 */
export interface ApiKeyCredentials {
  readonly type: "api-key";
  readonly apiKey: string;
  readonly baseURL?: string;
}

/**
 * Bearer token credentials (e.g. OAuth access tokens).
 * The auth extension is responsible for refresh logic; the provider
 * receives a currently-valid token.
 */
export interface BearerTokenCredentials {
  readonly type: "bearer-token";
  readonly token: string;
  readonly baseURL?: string;
}

/** Union of credential shapes the kernel recognizes. */
export type Credentials = ApiKeyCredentials | BearerTokenCredentials;

/**
 * What an auth extension registers with the kernel. A provider resolves its
 * credentials through this contract — the kernel never touches secrets
 * directly (the concrete vault is a core extension).
 */
export interface AuthContract {
  /** Unique identifier for this auth provider (e.g. "apikey", "claude-oauth"). */
  readonly id: string;

  /**
   * Resolve currently-valid credentials. May involve reading from the
   * secret vault (injected via Host API) or performing a token refresh.
   * Returns `null` if credentials are unavailable (e.g. not yet configured).
   */
  readonly resolve: () => Promise<Credentials | null>;
}
