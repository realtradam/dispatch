import type { ApiKeyCredentials, ChatMessage, ProviderStreamOptions } from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatProvider } from "./provider.js";

function makeCreds(): ApiKeyCredentials {
	return {
		type: "api-key",
		apiKey: "sk-test-1234567890abcdef",
		baseURL: "https://api.example.com/v1",
	};
}

function makeMessages(): readonly ChatMessage[] {
	return [{ role: "user", chunks: [{ type: "text", text: "Hello" }] }];
}

function sseBody(...lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const chunks = lines.map((l) => encoder.encode(`${l}\n`));
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				const chunk = chunks[index];
				if (chunk === undefined) throw new Error("empty chunk");
				controller.enqueue(chunk);
				index++;
			} else {
				controller.close();
			}
		},
	});
}

function okSseResponse(): Response {
	return new Response(
		sseBody(
			'data: {"id":"cmpl-1","choices":[{"delta":{"content":"Hi"},"index":0}]}',
			'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
			"data: [DONE]",
		),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

async function collectEvents(iter: AsyncIterable<unknown>): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of iter) {
		events.push(event);
	}
	return events;
}

describe("createOpenAICompatProvider stamps the given id on the ProviderContract + listModels", () => {
	it("stamps opts.id on ProviderContract.id", () => {
		const provider = createOpenAICompatProvider({
			credentials: makeCreds(),
			model: "test-model",
			id: "my-custom-id",
		});
		expect(provider.id).toBe("my-custom-id");
	});

	it("uses opts.id in listModels error labels (was hardcoded 'openai-compat')", async () => {
		const fetchFn = vi.fn(
			() =>
				new Response("Unauthorized", {
					status: 401,
					headers: { "Content-Type": "text/plain" },
				}) as unknown as ReturnType<FetchLike>,
		);
		const provider = createOpenAICompatProvider({
			credentials: makeCreds(),
			model: "test-model",
			id: "my-custom-id",
			fetchFn,
		});
		const listModels = provider.listModels;
		if (!listModels) throw new Error("listModels not defined");

		await expect(listModels()).rejects.toThrow("listModels[my-custom-id]: HTTP 401 — Unauthorized");
	});
});

describe("transformBody", () => {
	it("transformBody merges its returned fields into the request body", async () => {
		let capturedInit: RequestInit | undefined;
		const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return okSseResponse();
		}) as unknown as FetchLike;

		let receivedBody: Record<string, unknown> | undefined;
		let receivedOpts: ProviderStreamOptions | undefined;
		const provider = createOpenAICompatProvider({
			credentials: makeCreds(),
			model: "test-model",
			id: "umans",
			fetchFn,
			transformBody: (body, opts) => {
				receivedBody = body;
				receivedOpts = opts;
				return { reasoning_effort: "high" };
			},
		});

		await collectEvents(provider.stream(makeMessages(), [], { temperature: 0.5 }));

		// The hook was called with the body built so far + the stream opts.
		expect(receivedBody).toBeDefined();
		expect(receivedOpts?.temperature).toBe(0.5);
		expect(receivedBody?.model).toBe("test-model");

		// The captured wire body carries the merged field.
		expect(capturedInit?.body).toBeTypeOf("string");
		const wireBody = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
		expect(wireBody.reasoning_effort).toBe("high");
		expect(wireBody.model).toBe("test-model");
		expect(wireBody.stream).toBe(true);
		expect(wireBody.temperature).toBe(0.5);
	});

	it("transformBody absent → body byte-identical to before (regression)", async () => {
		let capturedInit: RequestInit | undefined;
		const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return okSseResponse();
		}) as unknown as FetchLike;

		const provider = createOpenAICompatProvider({
			credentials: makeCreds(),
			model: "test-model",
			id: "openai-compat",
			fetchFn,
			// No transformBody — default behavior.
		});

		await collectEvents(provider.stream(makeMessages(), [], { temperature: 0.5, maxTokens: 42 }));

		expect(capturedInit?.body).toBeTypeOf("string");
		const wireBody = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
		// Exact pre-refactor shape — no extra fields, no transformBody key leakage.
		expect(wireBody).toEqual({
			model: "test-model",
			messages: [{ role: "user", content: "Hello" }],
			stream: true,
			temperature: 0.5,
			max_tokens: 42,
		});
		expect("reasoning_effort" in wireBody).toBe(false);
	});
});
