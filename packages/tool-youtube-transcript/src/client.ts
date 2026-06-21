/**
 * TranscriptClient — the injected outermost edge for the youtube_transcript
 * tool.
 *
 * All effects (fetch, clock-via-abort-timeout) are injected so the pure
 * decision logic remains testable without real I/O. The factory builds a
 * single `getTranscript` method over a self-hosted transcriber instance (no
 * API key). Mirrors the tool-web-search FirecrawlClient's request structure:
 * per-request timeout combined with the caller's cancellation signal via
 * `AbortSignal.any`.
 */

import type { TranscriptResponse } from "./format.js";

export type FetchLike = typeof globalThis.fetch;

export const DEFAULT_BASE_URL = "http://100.102.55.49:41090";
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface TranscriptClient {
	readonly getTranscript: (url: string, signal: AbortSignal) => Promise<TranscriptResponse>;
}

export interface TranscriptClientDeps {
	readonly baseUrl: string;
	readonly fetchFn: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Create a TranscriptClient. `getTranscript` builds the request URL
 * (`${baseUrl}/api/transcript?url=${encodeURIComponent(url)}`), calls the
 * injected `fetchFn`, and handles HTTP + JSON errors. The per-request timeout
 * is combined with the caller's cancellation signal via `AbortSignal.any`.
 */
export function createTranscriptClient(deps: TranscriptClientDeps): TranscriptClient {
	const baseUrl = deps.baseUrl;
	const fetchFn = deps.fetchFn;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		async getTranscript(url: string, signal: AbortSignal): Promise<TranscriptResponse> {
			const endpoint = `${baseUrl}/api/transcript?url=${encodeURIComponent(url)}`;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			const combined = AbortSignal.any([signal, controller.signal]);
			try {
				let response: Response;
				try {
					response = await fetchFn(endpoint, {
						method: "GET",
						headers: { Accept: "application/json" },
						signal: combined,
					});
				} catch (err) {
					if (signal.aborted) {
						throw new Error("Request aborted.");
					}
					if (controller.signal.aborted) {
						throw new Error(`Transcriber request timed out after ${timeoutMs / 1000} seconds.`);
					}
					throw err;
				}
				if (!response.ok) {
					const text = await response.text().catch(() => "");
					throw new Error(
						`HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`,
					);
				}
				try {
					return (await response.json()) as TranscriptResponse;
				} catch {
					throw new Error("Failed to parse transcriber response as JSON");
				}
			} finally {
				clearTimeout(timeout);
			}
		},
	};
}
