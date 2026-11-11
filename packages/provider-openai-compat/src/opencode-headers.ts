/**
 * Request headers OpenCode Go requires of a client — PURE.
 *
 * OpenCode Go (https://opencode.ai/docs/go/#where-can-i-use-it) asks clients to
 * (1) identify themselves with their own user agent and (2) send a stable
 * session id in `x-opencode-session` for each conversation, which it uses for
 * routing and prompt caching. (2) is ENFORCED: a chat-completions request
 * without the header is rejected with HTTP 400 `MissingSessionID`.
 */

/** The per-conversation session header OpenCode Go requires on inference requests. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** The user agent Dispatch identifies itself with to OpenCode. */
export const OPENCODE_USER_AGENT = "dispatch/0.1";

/** A value that is safe to send verbatim as an HTTP header: visible ASCII, bounded. */
const HEADER_SAFE = /^[\x21-\x7E]{1,200}$/;

/**
 * The extra headers for one OpenCode chat-completions request.
 *
 * The session id is the request's conversation id, so every request of one
 * conversation shares a session (and so OpenCode's prompt cache). A request
 * made outside a conversation — or whose conversation id is not safe to send as
 * a header value — uses `fallbackSessionId` instead, so the required header is
 * ALWAYS present.
 */
export function buildOpenCodeRequestHeaders(
  conversationId: string | undefined,
  fallbackSessionId: string,
): Record<string, string> {
  const session =
    conversationId !== undefined && HEADER_SAFE.test(conversationId)
      ? conversationId
      : fallbackSessionId;
  return {
    "User-Agent": OPENCODE_USER_AGENT,
    [OPENCODE_SESSION_HEADER]: session,
  };
}
