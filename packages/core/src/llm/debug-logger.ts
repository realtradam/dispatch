/**
 * Debug logger for LLM API requests and responses.
 *
 * Enable via environment variable: DISPATCH_DEBUG_LLM=1
 *
 * Logs every outgoing request body and incoming response body to timestamped
 * files under `DISPATCH_DEBUG_LLM_DIR` (default: /tmp/dispatch/llm-debug/).
 *
 * Each request/response pair shares a sequence number for easy correlation.
 * Files are named: `{seq}_{timestamp}_{direction}_{model}.json`
 *
 * For streaming responses (SSE), the raw chunks are captured as they arrive
 * and written out as a JSON array when the stream completes.
 *
 * Additional logging layers:
 *  - Stream events: every AI SDK stream event (text-delta, tool-call, etc.)
 *  - Step lifecycle: step start/end, tool execution timing
 *  - Agent loop: step count, break conditions, tool call counts
 *
 * All output goes to stderr (console.error) for stream event logs, and to
 * files for request/response bodies (too large for console).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENABLED = !!process.env.DISPATCH_DEBUG_LLM;
const LOG_DIR = process.env.DISPATCH_DEBUG_LLM_DIR || "/tmp/dispatch/llm-debug";
let seq = 0;

/** Verbosity levels:
 *  1 = requests/responses only (files)
 *  2 = + stream events to stderr
 *  3 = + step lifecycle + agent loop details to stderr
 */
const VERBOSITY = Math.max(1, Number(process.env.DISPATCH_DEBUG_LLM_VERBOSITY) || 1);

function ensureDir(): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
	} catch {
		// best effort
	}
}

function ts(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeModel(model: string): string {
	return model.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60);
}

function sanitizeTab(tabId?: string): string {
	if (!tabId) return "notab";
	return tabId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40);
}

export function isDebugEnabled(): boolean {
	return ENABLED;
}

export function debugVerbosity(): number {
	return ENABLED ? VERBOSITY : 0;
}

/**
 * Allocate a fresh sequence number. Used by the fetch wrapper so the request
 * and the response share the same id without needing a separate `logRequest`
 * call from the agent loop (which doesn't see the actual HTTP body anyway).
 */
export function nextDebugSeq(): number {
	return ++seq;
}

/**
 * Log an outgoing request to the AI model endpoint.
 * Returns a request ID for correlating with the response.
 */
export function logRequest(data: {
	model: string;
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	body: unknown;
	tabId?: string;
	step?: number;
	provider?: string;
}): number {
	if (!ENABLED) return -1;
	ensureDir();
	const id = ++seq;
	const filename = `${String(id).padStart(5, "0")}_${ts()}_tab-${sanitizeTab(data.tabId)}_REQ_${sanitizeModel(data.model)}.json`;
	const payload = {
		_debug: {
			seq: id,
			direction: "request",
			timestamp: new Date().toISOString(),
			tabId: data.tabId,
			step: data.step,
			provider: data.provider,
		},
		url: data.url,
		method: data.method ?? "POST",
		headers: data.headers,
		body: data.body,
	};
	try {
		writeFileSync(join(LOG_DIR, filename), JSON.stringify(payload, null, 2));
	} catch (err) {
		console.error(`[dispatch-debug] Failed to write request log: ${err}`);
	}
	console.error(
		`[dispatch-debug] REQ #${id} → ${data.model} (step=${data.step ?? "?"}, tab=${data.tabId ?? "?"})`,
	);
	return id;
}

/**
 * Log the raw fetch-level request (the actual HTTP body sent to the provider).
 * Called from the instrumented fetch wrapper.
 */
export function logRawFetchRequest(data: {
	requestId: number;
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
	tabId?: string;
}): void {
	if (!ENABLED) return;
	ensureDir();
	const filename = `${String(data.requestId).padStart(5, "0")}_${ts()}_tab-${sanitizeTab(data.tabId)}_RAW_REQ.json`;
	const payload = {
		_debug: {
			seq: data.requestId,
			direction: "raw-request",
			timestamp: new Date().toISOString(),
			tabId: data.tabId,
		},
		url: data.url,
		method: data.method,
		headers: data.headers,
		body: tryParseJson(data.body),
	};
	try {
		writeFileSync(join(LOG_DIR, filename), JSON.stringify(payload, null, 2));
	} catch (err) {
		console.error(`[dispatch-debug] Failed to write raw request log: ${err}`);
	}
}

/**
 * Log the raw fetch-level response (HTTP status, headers, body).
 */
export function logRawFetchResponse(data: {
	requestId: number;
	url: string;
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string | null;
	isStreaming: boolean;
	tabId?: string;
}): void {
	if (!ENABLED) return;
	ensureDir();
	const filename = `${String(data.requestId).padStart(5, "0")}_${ts()}_tab-${sanitizeTab(data.tabId)}_RAW_RES_${data.status}.json`;
	const payload = {
		_debug: {
			seq: data.requestId,
			direction: "raw-response",
			timestamp: new Date().toISOString(),
			isStreaming: data.isStreaming,
			tabId: data.tabId,
		},
		url: data.url,
		status: data.status,
		statusText: data.statusText,
		headers: data.headers,
		body: tryParseJson(data.body),
	};
	try {
		writeFileSync(join(LOG_DIR, filename), JSON.stringify(payload, null, 2));
	} catch (err) {
		console.error(`[dispatch-debug] Failed to write raw response log: ${err}`);
	}
}

/**
 * Accumulator for streaming response chunks. Call `addChunk()` as SSE events
 * arrive, then `flush()` when the stream ends to write them all to disk.
 */
export class StreamResponseLogger {
	private requestId: number;
	private model: string;
	private tabId?: string;
	private chunks: Array<{ timestamp: string; data: string }> = [];
	private startTime: number;

	constructor(requestId: number, model: string, tabId?: string) {
		this.requestId = requestId;
		this.model = model;
		this.tabId = tabId;
		this.startTime = Date.now();
	}

	addChunk(rawLine: string): void {
		if (!ENABLED) return;
		this.chunks.push({
			timestamp: new Date().toISOString(),
			data: rawLine,
		});
	}

	flush(meta?: { finishReason?: string; error?: string }): void {
		if (!ENABLED) return;
		ensureDir();
		const elapsed = Date.now() - this.startTime;
		const filename = `${String(this.requestId).padStart(5, "0")}_${ts()}_tab-${sanitizeTab(this.tabId)}_STREAM_RES_${sanitizeModel(this.model)}.json`;
		const payload = {
			_debug: {
				seq: this.requestId,
				direction: "stream-response",
				timestamp: new Date().toISOString(),
				tabId: this.tabId,
				model: this.model,
				elapsedMs: elapsed,
				chunkCount: this.chunks.length,
				...meta,
			},
			chunks: this.chunks,
		};
		try {
			writeFileSync(join(LOG_DIR, filename), JSON.stringify(payload, null, 2));
		} catch (err) {
			console.error(`[dispatch-debug] Failed to write stream response log: ${err}`);
		}
		console.error(
			`[dispatch-debug] STREAM #${this.requestId} complete: ${this.chunks.length} chunks in ${elapsed}ms (${this.model})`,
		);
	}
}

/**
 * Log an AI SDK stream event (text-delta, tool-call, finish-step, etc.).
 * Only logs at verbosity >= 2.
 */
export function logStreamEvent(data: {
	requestId: number;
	step: number;
	eventType: string;
	detail?: unknown;
	tabId?: string;
}): void {
	if (!ENABLED || VERBOSITY < 2) return;
	const detail = data.detail !== undefined ? ` ${JSON.stringify(data.detail)}` : "";
	console.error(
		`[dispatch-debug] STREAM_EVENT #${data.requestId} step=${data.step} ${data.eventType}${detail}`,
	);
}

/**
 * Log step lifecycle events (step start, tool execution, step end).
 * Only logs at verbosity >= 3.
 */
export function logStepLifecycle(data: {
	tabId?: string;
	step: number;
	event: string;
	detail?: unknown;
}): void {
	if (!ENABLED || VERBOSITY < 3) return;
	const detail = data.detail !== undefined ? ` ${JSON.stringify(data.detail)}` : "";
	console.error(
		`[dispatch-debug] STEP tab=${data.tabId ?? "?"} step=${data.step} ${data.event}${detail}`,
	);
}

/**
 * Log agent loop-level events (loop start, break conditions, etc.).
 * Only logs at verbosity >= 3.
 */
export function logAgentLoop(data: {
	tabId?: string;
	event: string;
	detail?: unknown;
}): void {
	if (!ENABLED || VERBOSITY < 3) return;
	const detail = data.detail !== undefined ? ` ${JSON.stringify(data.detail)}` : "";
	console.error(`[dispatch-debug] AGENT tab=${data.tabId ?? "?"} ${data.event}${detail}`);
}

/**
 * Wrap a fetch function so every request/response pair is logged to disk
 * under `DISPATCH_DEBUG_LLM_DIR` when `DISPATCH_DEBUG_LLM` is set. When
 * disabled, returns the input fetch unchanged (zero overhead).
 *
 * Critical implementation note — SSE bodies: the AI SDK consumes
 * `response.body` as a `ReadableStream`. Reading it from anywhere else
 * (e.g. calling `.text()`) drains the stream and the SDK gets an empty
 * body. We therefore `response.clone()` the response and tee its body via
 * a `TransformStream` so each SSE line is forwarded to the SDK AND
 * captured into a `StreamResponseLogger`. The clone returns its own
 * Response object whose body the SDK reads normally.
 *
 * For non-streaming responses (`content-type` is not `text/event-stream`)
 * we just clone and read once via `.text()` — simpler and safe because
 * non-streaming bodies are bounded.
 */
export function wrapFetchWithLogging<
	F extends (...args: never[]) => Promise<Response> | Response,
>(baseFetch: F, opts: { tabId?: string; modelHint?: string }): F {
	if (!ENABLED) return baseFetch;
	const wrapped = async (...args: Parameters<F>) => {
		const requestId = ++seq;
		const [input, init] = args as unknown as [
			RequestInfo | URL,
			RequestInit | undefined,
		];
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url;
		const method =
			init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "POST");

		// Snapshot headers as a plain object for logging.
		const headerObj: Record<string, string> = {};
		try {
			const h = new Headers(init?.headers);
			h.forEach((v, k) => {
				// Redact bearer / api-key headers — useful in shared logs.
				if (/^(authorization|x-api-key|cookie)$/i.test(k)) {
					headerObj[k] = "<redacted>";
				} else {
					headerObj[k] = v;
				}
			});
		} catch {
			// best effort
		}

		// Capture request body. Most providers send a JSON string here; if it's
		// a stream/blob/etc. we skip body logging (rare in our codebase).
		let bodyStr: string | null = null;
		if (typeof init?.body === "string") {
			bodyStr = init.body;
		} else if (init?.body instanceof Uint8Array) {
			bodyStr = new TextDecoder().decode(init.body);
		}

		logRawFetchRequest({
			requestId,
			url,
			method,
			headers: headerObj,
			body: bodyStr,
			tabId: opts.tabId,
		});

		const response = await (baseFetch as unknown as typeof fetch)(input, init);

		const respHeaders: Record<string, string> = {};
		response.headers.forEach((v, k) => {
			respHeaders[k] = v;
		});
		const contentType = response.headers.get("content-type") ?? "";
		const isStreaming = contentType.includes("text/event-stream");

		if (!isStreaming) {
			// Clone so we don't drain the SDK's copy. Bounded body — safe to read.
			try {
				const cloned = response.clone();
				const text = await cloned.text();
				logRawFetchResponse({
					requestId,
					url,
					status: response.status,
					statusText: response.statusText,
					headers: respHeaders,
					body: text,
					isStreaming: false,
					tabId: opts.tabId,
				});
			} catch (err) {
				console.error(`[dispatch-debug] Failed to clone non-stream response: ${err}`);
			}
			return response;
		}

		// Streaming path: write a header file with status + headers immediately
		// (the body file comes later via StreamResponseLogger.flush).
		logRawFetchResponse({
			requestId,
			url,
			status: response.status,
			statusText: response.statusText,
			headers: respHeaders,
			body: null,
			isStreaming: true,
			tabId: opts.tabId,
		});

		// Tee the body through a TransformStream so each SSE chunk is captured
		// without consuming the stream the SDK needs.
		const streamLogger = new StreamResponseLogger(
			requestId,
			opts.modelHint ?? "stream",
			opts.tabId,
		);
		const decoder = new TextDecoder();
		const tee = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				try {
					streamLogger.addChunk(decoder.decode(chunk, { stream: true }));
				} catch {
					// never let logging break the stream
				}
				controller.enqueue(chunk);
			},
			flush() {
				try {
					streamLogger.flush();
				} catch {
					// best effort
				}
			},
		});

		// `response.body` is `ReadableStream<Uint8Array> | null`. If null (no
		// body), there's nothing to tee — return as-is.
		if (!response.body) return response;
		const teed = response.body.pipeThrough(tee);
		return new Response(teed, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	return wrapped as unknown as F;
}

function tryParseJson(s: string | null): unknown {
	if (s === null) return null;
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}
