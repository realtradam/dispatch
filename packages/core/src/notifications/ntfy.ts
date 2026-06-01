// ntfy.sh HTTP transport.
//
// ntfy's API is a simple POST to `https://ntfy.sh/<topic>` with the body
// as the message and metadata passed via HTTP headers:
//   Title:    notification title
//   Priority: 1..5 (3 = default)
//   Tags:     comma-separated emoji shortcodes
//   Click:    URL opened when the notification is tapped
//
// The server is hardcoded to the public ntfy.sh instance; the user only
// configures a topic name. We intentionally use `fetch` directly — no
// SDK, no extra deps.

import type { NotificationEvent, NtfyConfig } from "./types.js";
import { NTFY_DEFAULT_PRIORITIES, NTFY_DEFAULT_TAGS } from "./types.js";

export interface NtfySendResult {
	ok: boolean;
	status?: number;
	error?: string;
}

/**
 * Lightweight fetch shape so callers (and tests) can inject a mock without
 * pulling in the DOM `fetch` type from a `Headers` instance.
 */
export type FetchLike = (
	input: string,
	init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; statusText?: string; text(): Promise<string> }>;

/** Base URL of the public ntfy.sh server. */
export const NTFY_BASE_URL = "https://ntfy.sh";

/**
 * Build the publish URL for a topic name.
 *
 * No client-side validation of the topic content: ntfy.sh's accepted
 * character set has changed over time and a regex here only locks users
 * out of legitimate topics. The topic is URL-encoded so the resulting
 * URL is always syntactically valid; if ntfy rejects the name the HTTP
 * error surfaces on the first send / `Send test`.
 */
export function buildNtfyUrl(topic: string): string {
	return `${NTFY_BASE_URL}/${encodeURIComponent(topic.trim())}`;
}

/**
 * Send a single notification to the configured ntfy topic.
 *
 * Fire-and-forget at call sites: the dispatcher uses
 * `void sendNtfy(...).catch(...)` so a slow/broken ntfy server never blocks
 * a turn. We still return a structured result so the explicit
 * `POST /notifications/test` route can surface failures back to the UI.
 *
 * Pure with respect to `config` / `event` — no DB, no module state.
 */
export async function sendNtfy(
	config: NtfyConfig,
	event: NotificationEvent,
	fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
	timeoutMs = 10_000,
): Promise<NtfySendResult> {
	if (!config.enabled) return { ok: false, error: "Notifications are disabled" };
	if (!config.topic.trim()) return { ok: false, error: "Topic is required" };
	const targetUrl = buildNtfyUrl(config.topic);

	const priority = event.priority ?? NTFY_DEFAULT_PRIORITIES[event.type] ?? 3;
	const baseTags = event.tags ?? NTFY_DEFAULT_TAGS[event.type] ?? [];
	const tags = [...baseTags];
	if (event.tabId) {
		// Short, ASCII-only tag so ntfy's comma-separated header parser is happy.
		tags.push(`tab-${event.tabId.slice(0, 8)}`);
	}

	const headers: Record<string, string> = {
		// ntfy is tolerant of non-ASCII in the Title header but many proxies
		// aren't — sanitizeHeader strips CR/LF/control chars (injection guard)
		// and leaves UTF-8 in place. Body is sent verbatim as UTF-8.
		Title: sanitizeHeader(event.title),
		Priority: String(priority),
		"Content-Type": "text/plain; charset=utf-8",
	};
	if (tags.length > 0) headers.Tags = tags.map(sanitizeHeader).join(",");
	if (event.clickUrl) headers.Click = sanitizeHeader(event.clickUrl);
	const authValue = buildAuthHeaderValue(config.authToken);
	if (authValue) headers.Authorization = authValue;

	// Per-request abort so a hung server doesn't pin a Bun worker forever.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetchImpl(targetUrl, {
			method: "POST",
			headers,
			body: event.message,
			signal: controller.signal,
		});
		if (!res.ok) {
			const text = await safeReadText(res);
			return {
				ok: false,
				status: res.status,
				error: `ntfy responded ${res.status} ${res.statusText ?? ""}: ${text}`.trim(),
			};
		}
		return { ok: true, status: res.status };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Build the `Authorization` header value from the user-configured token.
 *
 * - Empty/blank ⇒ no header.
 * - Already starts with `Bearer ` / `Basic ` / etc. (RFC 7235 scheme + space)
 *   ⇒ used verbatim. Lets users paste a complete header for Basic auth or
 *   any other scheme their private ntfy server supports.
 * - Otherwise ⇒ prefixed with `Bearer ` (the common case).
 */
function buildAuthHeaderValue(rawToken: string): string | null {
	const trimmed = (rawToken ?? "").trim();
	if (!trimmed) return null;
	if (/^[A-Za-z][A-Za-z0-9._~+/-]*\s+\S/.test(trimmed)) {
		// Already includes a scheme token (e.g. "Bearer xyz", "Basic dXNlcjpw").
		return sanitizeHeader(trimmed);
	}
	return `Bearer ${sanitizeHeader(trimmed)}`;
}

function sanitizeHeader(value: string): string {
	// Strip CR/LF (header injection guard) and other control chars, then trim.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
	return value.replace(/[\r\n\u0000-\u001f]+/g, " ").trim();
}

async function safeReadText(res: { text(): Promise<string> }): Promise<string> {
	try {
		const t = await res.text();
		return t.length > 200 ? `${t.slice(0, 200)}…` : t;
	} catch {
		return "";
	}
}
