/** Pure transport-boundary guard; IDs are never coerced, trimmed, or URL-decoded here. */
export function isValidConversationId(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(raw);
}

/** Accept UUIDs and legacy IDs alike, or return a transport-ready validation error. */
export function parseConversationId(raw: unknown): string | { readonly error: string } {
  return isValidConversationId(raw)
    ? raw
    : {
        error: "Field 'conversationId' must be a non-empty string matching ^[A-Za-z0-9_-]{1,128}$",
      };
}
