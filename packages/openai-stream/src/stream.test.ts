import type { ChatMessage, Logger, ProviderEvent, Span } from "@dispatch/kernel";
import type { HttpExchangeFixture } from "@dispatch/trace-replay";
import { loadFixture, recordFetch, replayFetch, serializeFixture } from "@dispatch/trace-replay";
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

describe("streamChat — hermetic replay (trace-replay)", () => {
	const testDir = new URL(".", import.meta.url).pathname;
	const fixturePath = `${testDir}__fixtures__/flash-text-turn.json`;
	const toolFixturePath = `${testDir}__fixtures__/tool-call-turn.json`;

	it("replays a text-turn fixture and produces correct ProviderEvents", async () => {
		const fixture = loadFixture(fixturePath);
		const { fetch: replayFetchFn, getCapturedRequest } = replayFetch(fixture, { chunkBytes: 64 });

		const config: StreamConfig = {
			baseURL: "https://api.example.com/v1",
			apiKey: "sk-test-1234567890abcdef",
			model: "deepseek-v4-flash",
			fetchFn: replayFetchFn,
		};

		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "Hello, how are you?" }] },
		];

		const events = await collectEvents(streamChat(config, messages, []));

		const textDeltas = events.filter(
			(e): e is Extract<ProviderEvent, { type: "text-delta" }> => e.type === "text-delta",
		);
		const fullText = textDeltas.map((e) => e.delta).join("");
		expect(fullText).toBe("Hello there friend");

		const finishEvents = events.filter((e) => e.type === "finish");
		expect(finishEvents).toHaveLength(1);
		expect(finishEvents[0]).toEqual({ type: "finish", reason: "stop" });

		const usageEvents = events.filter(
			(e): e is Extract<ProviderEvent, { type: "usage" }> => e.type === "usage",
		);
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]?.usage.inputTokens).toBe(665);
		expect(usageEvents[0]?.usage.outputTokens).toBe(90);
		expect(usageEvents[0]?.usage.cacheReadTokens).toBe(384);

		const captured = getCapturedRequest();
		assertDefined(captured);
		expect(captured.method).toBe("POST");
		expect(captured.url).toBe("https://api.example.com/v1/chat/completions");
		expect(captured.headers["Content-Type"]).toBe("application/json");
		expect(captured.headers.Authorization).toBe("Bearer sk-test-1234567890abcdef");

		assertDefined(captured.body);
		const capturedBody = JSON.parse(captured.body);
		expect(capturedBody.model).toBe("deepseek-v4-flash");
		expect(capturedBody.stream).toBe(true);
		expect(capturedBody.messages).toEqual([{ role: "user", content: "Hello, how are you?" }]);
	});

	it("replays a tool-call-turn fixture and produces tool-call + finish events", async () => {
		const fixture = loadFixture(toolFixturePath);
		const { fetch: replayFetchFn, getCapturedRequest } = replayFetch(fixture, { chunkBytes: 48 });

		const config: StreamConfig = {
			baseURL: "https://api.example.com/v1",
			apiKey: "sk-test-1234567890abcdef",
			model: "deepseek-v4-flash",
			fetchFn: replayFetchFn,
		};

		const messages: ChatMessage[] = [
			{ role: "user", chunks: [{ type: "text", text: "What is the weather in Tokyo?" }] },
		];

		const weatherTool = {
			name: "get_weather",
			description: "Get current weather for a location",
			parameters: {
				type: "object" as const,
				properties: { location: { type: "string" as const } },
				required: ["location"],
			},
			execute: async () => ({ content: "" }),
		};

		const events = await collectEvents(streamChat(config, messages, [weatherTool]));

		const toolCalls = events.filter(
			(e): e is Extract<ProviderEvent, { type: "tool-call" }> => e.type === "tool-call",
		);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.toolCallId).toBe("call_abc123");
		expect(toolCalls[0]?.toolName).toBe("get_weather");
		expect(toolCalls[0]?.input).toEqual({ location: "Tokyo" });

		const finishEvents = events.filter((e) => e.type === "finish");
		expect(finishEvents).toHaveLength(1);
		expect(finishEvents[0]).toEqual({ type: "finish", reason: "tool_calls" });

		const usageEvents = events.filter(
			(e): e is Extract<ProviderEvent, { type: "usage" }> => e.type === "usage",
		);
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]?.usage.inputTokens).toBe(45);
		expect(usageEvents[0]?.usage.outputTokens).toBe(12);
		expect(usageEvents[0]?.usage.cacheReadTokens).toBe(30);
		expect(usageEvents[0]?.usage.cacheWriteTokens).toBe(5);

		const captured = getCapturedRequest();
		assertDefined(captured);
		expect(captured.method).toBe("POST");
		assertDefined(captured.body);
		const capturedBody = JSON.parse(captured.body);
		expect(capturedBody.tools).toHaveLength(1);
		expect(capturedBody.tools[0].function.name).toBe("get_weather");
	});
});

describe("streamChat — record-mode redaction (trace-replay)", () => {
	/**
	 * Graduated secret mask — §6 tiers. Duplicated locally (isolation-over-dry).
	 * ≥13 → reveal 3 each side · 11–12 → 2 · 8–10 → 1 · ≤7 → full mask.
	 */
	function maskSecret(value: string): string {
		const len = value.length;
		if (len <= 7) return "…redacted…";
		let reveal: number;
		if (len >= 13) {
			reveal = 3;
		} else if (len >= 11) {
			reveal = 2;
		} else {
			reveal = 1;
		}
		return `${value.slice(0, reveal)}…redacted…${value.slice(-reveal)}`;
	}

	it("self-redacts auth header in onExchange and produces a secret-free fixture", async () => {
		const apiKey = "sk-abcdefghijkmnop";
		const responseBody =
			'data: {"id":"cmpl-r","choices":[{"delta":{"content":"ok"},"index":0}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cache_read_tokens":0,"cache_write_tokens":0}}\n\ndata: [DONE]\n';

		let capturedFixture: HttpExchangeFixture | undefined;
		const wrappedFetch = recordFetch(
			async () =>
				new Response(responseBody, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			(fx) => {
				const redactedHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(fx.request.headers)) {
					if (key.toLowerCase() === "authorization") {
						const token = value.replace(/^Bearer\s+/i, "");
						redactedHeaders[key] = `Bearer ${maskSecret(token)}`;
					} else {
						redactedHeaders[key] = value;
					}
				}
				capturedFixture = {
					request: { ...fx.request, headers: redactedHeaders },
					response: fx.response,
					...(fx.meta !== undefined ? { meta: fx.meta } : {}),
				};
			},
		);

		await wrappedFetch("https://api.example.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: '{"model":"test","messages":[{"role":"user","content":"hi"}],"stream":true}',
		});

		assertDefined(capturedFixture);

		expect(capturedFixture.request.headers.authorization).toBe("Bearer sk-…redacted…nop");
		expect(capturedFixture.request.headers.authorization).not.toContain("abcdefghijkm");
		expect(capturedFixture.request.headers["content-type"]).toBe("application/json");

		expect(capturedFixture.request.body).toContain('"model":"test"');
		expect(capturedFixture.request.body).toContain('"content":"hi"');

		expect(capturedFixture.response.status).toBe(200);
		expect(capturedFixture.response.body).toBe(responseBody);

		const serialized = serializeFixture(capturedFixture);
		expect(serialized).toContain("Bearer sk-…redacted…nop");
		expect(serialized).not.toContain("abcdefghijkm");
		expect(serialized).toContain("content");
		expect(serialized).toContain("hi");
	});

	it("redacts capitalized Authorization header (the real leak casing)", async () => {
		const apiKey = "sk-LIVEKEY1234567890abcdef";
		const responseBody = "data: [DONE]\n";

		let capturedFixture: HttpExchangeFixture | undefined;
		const wrappedFetch = recordFetch(
			async () =>
				new Response(responseBody, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			(fx) => {
				const redactedHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(fx.request.headers)) {
					if (key.toLowerCase() === "authorization") {
						const token = value.replace(/^Bearer\s+/i, "");
						redactedHeaders[key] = `Bearer ${maskSecret(token)}`;
					} else {
						redactedHeaders[key] = value;
					}
				}
				capturedFixture = {
					request: { ...fx.request, headers: redactedHeaders },
					response: fx.response,
				};
			},
		);

		await wrappedFetch("https://api.example.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: '{"model":"test","messages":[],"stream":true}',
		});

		assertDefined(capturedFixture);
		expect(capturedFixture.request.headers.Authorization).toBe("Bearer sk-…redacted…def");
		expect(capturedFixture.request.headers.Authorization).not.toContain("LIVEKEY1234567890abc");

		const serialized = serializeFixture(capturedFixture);
		expect(serialized).not.toContain("LIVEKEY1234567890abc");
		expect(serialized).toContain("Bearer sk-…redacted…def");
	});

	it("redacts lowercase authorization header", async () => {
		const apiKey = "sk-abcdefghijkmnop";

		let capturedFixture: HttpExchangeFixture | undefined;
		const wrappedFetch = recordFetch(
			async () => new Response("data: [DONE]\n", { status: 200 }),
			(fx) => {
				const redactedHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(fx.request.headers)) {
					if (key.toLowerCase() === "authorization") {
						const token = value.replace(/^Bearer\s+/i, "");
						redactedHeaders[key] = `Bearer ${maskSecret(token)}`;
					} else {
						redactedHeaders[key] = value;
					}
				}
				capturedFixture = {
					request: { ...fx.request, headers: redactedHeaders },
					response: fx.response,
				};
			},
		);

		await wrappedFetch("https://api.example.com/v1/chat/completions", {
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}` },
			body: null,
		});

		assertDefined(capturedFixture);
		expect(capturedFixture.request.headers.authorization).toBe("Bearer sk-…redacted…nop");
		expect(capturedFixture.request.headers.authorization).not.toContain("abcdefghijkm");
	});

	it("guard: no header named authorization (any case) survives with a raw sk- token", async () => {
		const apiKey = "sk-REALKEY_1234567890abcdef";

		let capturedFixture: HttpExchangeFixture | undefined;
		const wrappedFetch = recordFetch(
			async () => new Response("data: [DONE]\n", { status: 200 }),
			(fx) => {
				const redactedHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(fx.request.headers)) {
					if (key.toLowerCase() === "authorization") {
						const token = value.replace(/^Bearer\s+/i, "");
						redactedHeaders[key] = `Bearer ${maskSecret(token)}`;
					} else {
						redactedHeaders[key] = value;
					}
				}
				capturedFixture = {
					request: { ...fx.request, headers: redactedHeaders },
					response: fx.response,
				};
			},
		);

		await wrappedFetch("https://api.example.com/v1/chat/completions", {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}` },
			body: null,
		});

		assertDefined(capturedFixture);
		for (const [key, value] of Object.entries(capturedFixture.request.headers)) {
			if (key.toLowerCase() === "authorization") {
				expect(value).not.toContain(apiKey);
				expect(value).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
			}
		}

		const serialized = serializeFixture(capturedFixture);
		expect(serialized).not.toContain(apiKey);
		expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
	});

	it("redacts a short API key (≤7 chars → full mask)", async () => {
		let capturedFixture: HttpExchangeFixture | undefined;
		const wrappedFetch = recordFetch(
			async () => new Response("data: [DONE]\n", { status: 200 }),
			(fx) => {
				const redactedHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(fx.request.headers)) {
					if (key.toLowerCase() === "authorization") {
						const token = value.replace(/^Bearer\s+/i, "");
						redactedHeaders[key] = `Bearer ${maskSecret(token)}`;
					} else {
						redactedHeaders[key] = value;
					}
				}
				capturedFixture = {
					request: { ...fx.request, headers: redactedHeaders },
					response: fx.response,
				};
			},
		);

		await wrappedFetch("https://api.example.com/v1/chat/completions", {
			method: "POST",
			headers: { authorization: "Bearer secret!" },
			body: null,
		});

		assertDefined(capturedFixture);
		expect(capturedFixture.request.headers.authorization).toBe("Bearer …redacted…");
	});
});
