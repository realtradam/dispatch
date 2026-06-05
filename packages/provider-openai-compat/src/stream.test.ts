import type { ChatMessage, Logger, ProviderEvent, Span } from "@dispatch/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type StreamConfig, streamChat } from "./stream.js";

async function collectEvents(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of iter) {
		events.push(event);
	}
	return events;
}

function assertDefined<T>(v: T, msg?: string): asserts v is NonNullable<T> {
	if (v === undefined || v === null) {
		throw new Error(msg ?? "expected defined");
	}
}

interface CapturedSpan {
	name: string;
	attrs: Record<string, string | number | boolean | null>;
	body?: string | undefined;
	endOutcome?:
		| { err?: unknown; attrs?: Record<string, string | number | boolean | null> }
		| undefined;
}

function createFakeLogger(): { logger: Logger; spans: CapturedSpan[] } {
	const spans: CapturedSpan[] = [];
	let spanAttrBuffer: Record<string, string | number | boolean | null> = {};
	let spanBodyBuffer: string | undefined;

	const fakeSpan: Span = {
		id: "fake-span-id",
		log: {} as Logger,
		setAttributes(attrs) {
			Object.assign(spanAttrBuffer, attrs);
		},
		addLink() {},
		child() {
			return fakeSpan;
		},
		end(outcome?) {
			spans.push({
				name: "provider.request",
				attrs: { ...spanAttrBuffer },
				body: spanBodyBuffer,
				endOutcome: outcome as CapturedSpan["endOutcome"],
			});
		},
	};

	const logger: Logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		child() {
			return logger;
		},
		span(_name, attrs, body) {
			spanAttrBuffer = attrs ? { ...attrs } : {};
			spanBodyBuffer = body;
			return fakeSpan;
		},
	};

	return { logger, spans };
}

function makeConfig(apiKey = "sk-test-1234567890abcdef"): StreamConfig {
	return {
		baseURL: "https://api.example.com/v1",
		apiKey,
		model: "test-model",
	};
}

function mockFetch(handler: (url: string | URL | Request, init?: RequestInit) => unknown): void {
	globalThis.fetch = vi.fn(handler) as unknown as typeof globalThis.fetch;
}

function makeMessages(): readonly ChatMessage[] {
	return [
		{
			role: "user",
			chunks: [{ type: "text", text: "Hello" }],
		},
	];
}

function sseBody(...lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const chunks = lines.map((l) => encoder.encode(`${l}\n`));
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				const chunk = chunks[index];
				assertDefined(chunk);
				controller.enqueue(chunk);
				index++;
			} else {
				controller.close();
			}
		},
	});
}

describe("streamChat — provider.request AFTER capture", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("opens a provider.request span with verbatim request body", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig();

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-1","choices":[{"delta":{"content":"Hi"},"index":0}]}',
						'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		const events = await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		expect(events.some((e) => e.type === "text-delta")).toBe(true);
		expect(spans).toHaveLength(1);

		assertDefined(spans[0]);
		const span = spans[0];
		expect(span.name).toBe("provider.request");
		expect(span.attrs["request.method"]).toBe("POST");
		expect(span.attrs["request.body"]).toBeUndefined();

		assertDefined(span.body);
		const capturedBody = JSON.parse(span.body);
		expect(capturedBody.model).toBe("test-model");
		expect(capturedBody.stream).toBe(true);
		expect(capturedBody.messages).toEqual([{ role: "user", content: "Hello" }]);

		expect(span.endOutcome?.attrs?.status).toBe(200);
	});

	it("redacts a long API key (≥13 chars → reveal 3 each side)", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig("sk-abcdefghijkmnop");

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-2","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-2","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		assertDefined(spans[0]);
		const span = spans[0];
		const authHeader = span.attrs["request.headers.authorization"] as string;
		expect(authHeader).toBe("Bearer sk-…redacted…nop");
		expect(authHeader).not.toContain("abcdefghijkm");
	});

	it("redacts a medium API key (8–10 chars → reveal 1 each side)", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig("sk-abcde");

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-3","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-3","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		assertDefined(spans[0]);
		const span = spans[0];
		const authHeader = span.attrs["request.headers.authorization"] as string;
		expect(authHeader).toBe("Bearer s…redacted…e");
	});

	it("redacts a short API key (≤7 chars → full mask)", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig("secret!");

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-4","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-4","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		assertDefined(spans[0]);
		const span = spans[0];
		const authHeader = span.attrs["request.headers.authorization"] as string;
		expect(authHeader).toBe("Bearer …redacted…");
	});

	it("captures cache tokens from the response", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig();

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-5","choices":[{"delta":{"content":"Hi"},"index":0}]}',
						'data: {"id":"cmpl-5","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						'data: {"id":"cmpl-5","usage":{"prompt_tokens":100,"completion_tokens":20,"cache_read_tokens":80,"cache_write_tokens":10}}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		assertDefined(spans[0]);
		const span = spans[0];
		expect(span.endOutcome?.attrs?.["usage.inputTokens"]).toBe(100);
		expect(span.endOutcome?.attrs?.["usage.outputTokens"]).toBe(20);
		expect(span.endOutcome?.attrs?.["usage.cacheReadTokens"]).toBe(80);
		expect(span.endOutcome?.attrs?.["usage.cacheWriteTokens"]).toBe(10);
	});

	it("captures cache_read_tokens alone", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig();

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-6","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-6","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						'data: {"id":"cmpl-6","usage":{"prompt_tokens":50,"completion_tokens":5,"cache_read_tokens":45}}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		assertDefined(spans[0]);
		const span = spans[0];
		expect(span.endOutcome?.attrs?.["usage.cacheReadTokens"]).toBe(45);
		expect(span.endOutcome?.attrs?.["usage.cacheWriteTokens"]).toBeUndefined();
	});

	it("records HTTP error status and error body without throwing", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig();

		mockFetch(
			() =>
				new Response("Invalid request body", {
					status: 400,
					headers: { "Content-Type": "text/plain" },
				}),
		);

		const events = await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			type: "error",
			message: "HTTP 400: Invalid request body",
			code: "400",
			retryable: false,
		});

		expect(spans).toHaveLength(1);
		assertDefined(spans[0]);
		const span = spans[0];
		expect(span.endOutcome?.attrs?.status).toBe(400);
		expect(span.endOutcome?.attrs?.["response.error_body"]).toBe("Invalid request body");
		expect(span.endOutcome?.err).toBeInstanceOf(Error);
	});

	it("records network error without throwing", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig();

		mockFetch(() => {
			throw new Error("connection refused");
		});

		const events = await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			type: "error",
			message: "connection refused",
			retryable: true,
		});

		expect(spans).toHaveLength(1);
		assertDefined(spans[0]);
		const span = spans[0];
		expect(span.endOutcome?.err).toBeInstanceOf(Error);
		expect((span.endOutcome?.err as Error).message).toBe("connection refused");
	});

	it("detects cache_control breakpoint absence in a normal request body", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig();

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-7","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-7","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		assertDefined(spans[0]);
		const span = spans[0];
		expect(span.attrs["request.cache_control_present"]).toBe(false);
	});

	it("does not open a span when opts.logger is absent", async () => {
		const config = makeConfig();

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-8","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-8","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		const events = await collectEvents(streamChat(config, makeMessages(), []));

		expect(events.some((e) => e.type === "text-delta")).toBe(true);
	});

	it("fail-safe: logger throwing does not break stream()", async () => {
		const brokenLogger: Logger = {
			debug() {},
			info() {},
			warn() {},
			error() {},
			child() {
				return brokenLogger;
			},
			span() {
				throw new Error("logger exploded");
			},
		};

		const config = makeConfig();

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-9","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-9","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		const events = await collectEvents(
			streamChat(config, makeMessages(), [], { logger: brokenLogger }),
		);

		expect(events.some((e) => e.type === "text-delta")).toBe(true);
		expect(events.some((e) => e.type === "finish")).toBe(true);
	});

	it("redacts an 11-char API key (reveal 2 each side)", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig("sk-abcde1234");

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-10","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-10","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		assertDefined(spans[0]);
		const span = spans[0];
		const authHeader = span.attrs["request.headers.authorization"] as string;
		expect(authHeader).toBe("Bearer sk…redacted…34");
	});

	it("records server error (500) as retryable", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig();

		mockFetch(
			() =>
				new Response("Internal Server Error", {
					status: 500,
					headers: { "Content-Type": "text/plain" },
				}),
		);

		const events = await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			type: "error",
			message: "HTTP 500: Internal Server Error",
			code: "500",
			retryable: true,
		});

		expect(spans).toHaveLength(1);
		assertDefined(spans[0]);
		expect(spans[0].endOutcome?.attrs?.status).toBe(500);
	});

	it("captures model and url on the span", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig();

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-11","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-11","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await collectEvents(streamChat(config, makeMessages(), [], { logger }));

		assertDefined(spans[0]);
		const span = spans[0];
		expect(span.attrs.model).toBe("test-model");
		expect(span.attrs.url).toBe("https://api.example.com/v1/chat/completions");
	});

	it("uses opts.model override in capture", async () => {
		const { logger, spans } = createFakeLogger();
		const config = makeConfig();

		mockFetch(
			() =>
				new Response(
					sseBody(
						'data: {"id":"cmpl-12","choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"id":"cmpl-12","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await collectEvents(
			streamChat(config, makeMessages(), [], { logger, model: "override-model" }),
		);

		assertDefined(spans[0]);
		const span = spans[0];
		expect(span.attrs.model).toBe("override-model");

		assertDefined(span.body);
		const capturedBody = JSON.parse(span.body);
		expect(capturedBody.model).toBe("override-model");
	});
});
