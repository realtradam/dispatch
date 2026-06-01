// ntfy.sh HTTP transport.
//
// ntfy's API is a simple POST to `https://<server>/<topic>` with the body
// as the message and metadata passed via HTTP headers:
//   Title:    notification title
//   Priority: 1..5 (3 = default)
//   Tags:     comma-separated emoji shortcodes
//   Click:    URL opened when the notification is tapped
//
// We intentionally use `fetch` directly — no SDK, no extra deps.

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

/**
 * ntfy topic-name rules: 1–64 chars, ASCII alphanumerics + `-` and `_`. Sourced
 * from the ntfy server (cf. binwiederhier/ntfy issue #1451 — longer names
 * silently 404). Matching this client-side keeps users from saving topic URLs
 * that look fine but only fail at publish time.
 */
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a ntfy topic URL. Accepts only `http(s)://host/topic` where
 * `topic` is a single path segment of 1–64 chars matching `[A-Za-z0-9_-]`.
 * Returns `null` on success, a human-readable error string on failure.
 */
export function validateTopicUrl(topicUrl: string): string | null {
	const trimmed = topicUrl.trim();
	if (!trimmed) return "Topic URL is required";
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return "Topic URL is not a valid URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return "Topic URL must use http:// or https://";
	}
	// Path must be exactly one topic segment.
	const topic = url.pathname.replace(/^\/+|\/+$/g, "");
	if (!topic) return "Topic URL must include a topic name (e.g. https://ntfy.sh/my-topic)";
	if (topic.includes("/")) {
		return "Topic URL must point at a single topic (no extra path segments)";
	}
	if (!NTFY_TOPIC_RE.test(topic)) {
		return "Topic name must be 1–64 characters, letters/numbers/underscore/hyphen only";
	}
	return null;
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
	const topicErr = validateTopicUrl(config.topicUrl);
	if (topicErr) return { ok: false, error: topicErr };

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
		const res = await fetchImpl(config.topicUrl.trim(), {
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
