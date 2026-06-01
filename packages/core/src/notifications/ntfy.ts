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
 * Validate a ntfy topic URL. Accepts only `http(s)://host/topic` with a
 * non-empty topic path. Returns `null` on success, a human-readable error
 * string on failure.
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
	// Path must be a non-empty topic (more than just "/")
	const topic = url.pathname.replace(/^\/+|\/+$/g, "");
	if (!topic) return "Topic URL must include a topic name (e.g. https://ntfy.sh/my-topic)";
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
		// ntfy treats the title/priority/tags/click headers as ASCII-only. Strip
		// control chars from the title; the body is sent UTF-8 verbatim.
		Title: sanitizeHeader(event.title),
		Priority: String(priority),
		"Content-Type": "text/plain; charset=utf-8",
	};
	if (tags.length > 0) headers.Tags = tags.map(sanitizeHeader).join(",");
	if (event.clickUrl) headers.Click = event.clickUrl;
	if (config.authToken && config.authToken.trim() !== "") {
		headers.Authorization = `Bearer ${config.authToken.trim()}`;
	}

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

function sanitizeHeader(value: string): string {
	// Strip CR/LF (header injection guard) and trim. ntfy is tolerant of
	// non-ASCII in titles, but we still drop control chars.
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
