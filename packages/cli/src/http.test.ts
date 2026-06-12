import type { AgentEvent, ChatRequest } from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import { fetchModels, streamChat } from "./http.js";

function ndjsonLines(...events: AgentEvent[]): string {
	return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

function makeFakeFetch(responseBody: string, headers?: Record<string, string>) {
	const fn = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
		const encoder = new TextEncoder();
		const chunks = responseBody.split("|||");
		let i = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (i < chunks.length) {
					const chunk = chunks[i];
					if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
					i++;
				} else {
					controller.close();
				}
			},
		});
		return new Response(stream, {
			status: 200,
			headers: headers ?? {},
		});
	};
	return fn as unknown as typeof fetch;
}

describe("streamChat", () => {
	it("parses NDJSON events and returns conversationId", async () => {
		const event1: AgentEvent = {
			type: "text-delta",
			conversationId: "c1",
			turnId: "t1",
			delta: "Hello",
		};
		const event2: AgentEvent = {
			type: "done",
			conversationId: "c1",
			turnId: "t1",
			reason: "completed",
		};

		const body = ndjsonLines(event1, event2);
		const fakeFetch = makeFakeFetch(body, { "X-Conversation-Id": "c1" });

		const { conversationId, events } = await streamChat(
			{ fetchImpl: fakeFetch },
			{
				server: "http://localhost:24203",
				request: { message: "hi", model: "openai/gpt-4" },
			},
		);

		expect(conversationId).toBe("c1");

		const collected: AgentEvent[] = [];
		for await (const e of events) {
			collected.push(e);
		}

		expect(collected).toEqual([event1, event2]);
	});

	it("handles NDJSON split across chunks", async () => {
		const event1: AgentEvent = {
			type: "text-delta",
			conversationId: "c",
			turnId: "t",
			delta: "Hi",
		};
		const event2: AgentEvent = {
			type: "usage",
			conversationId: "c",
			turnId: "t",
			usage: { inputTokens: 10, outputTokens: 5 },
		};

		const fullNdjson = ndjsonLines(event1, event2);
		// Split mid-line: after 20 chars
		const mid = 20;
		const chunk1 = fullNdjson.slice(0, mid);
		const chunk2 = fullNdjson.slice(mid);

		const fakeFetch = makeFakeFetch(`${chunk1}|||${chunk2}`, {
			"X-Conversation-Id": "c",
		});

		const { events } = await streamChat(
			{ fetchImpl: fakeFetch },
			{
				server: "http://localhost:24203",
				request: { message: "hi" },
			},
		);

		const collected: AgentEvent[] = [];
		for await (const e of events) {
			collected.push(e);
		}

		expect(collected).toEqual([event1, event2]);
	});

	it("throws on non-OK status", async () => {
		const fakeFetch = (async (): Promise<Response> =>
			new Response("not found", { status: 404 })) as unknown as typeof fetch;

		await expect(
			streamChat(
				{ fetchImpl: fakeFetch },
				{
					server: "http://localhost:24203",
					request: { message: "hi" },
				},
			),
		).rejects.toThrow("POST /chat failed with status 404");
	});

	it("throws when response has no body", async () => {
		const fakeFetch = (async (): Promise<Response> =>
			new Response(null, { status: 200 })) as unknown as typeof fetch;

		await expect(
			streamChat(
				{ fetchImpl: fakeFetch },
				{
					server: "http://localhost:24203",
					request: { message: "hi" },
				},
			),
		).rejects.toThrow("no body");
	});

	it("includes reasoningEffort in request body when set", async () => {
		let capturedBody: string | undefined;
		const doneEvent: AgentEvent = {
			type: "done",
			conversationId: "c",
			turnId: "t",
			reason: "completed",
		};
		const fakeFetch = async (
			_url: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			capturedBody = init?.body as string;
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(encoder.encode(`${JSON.stringify(doneEvent)}\n`));
					controller.close();
				},
			});
			return new Response(stream, { status: 200 });
		};

		await streamChat(
			{ fetchImpl: fakeFetch as unknown as typeof fetch },
			{
				server: "http://localhost:24203",
				request: { message: "hi", reasoningEffort: "xhigh" },
			},
		);

		expect(capturedBody).toBeDefined();
		const parsed = JSON.parse(capturedBody as string) as ChatRequest;
		expect(parsed.reasoningEffort).toBe("xhigh");
	});

	it("omits reasoningEffort from request body when not set", async () => {
		let capturedBody: string | undefined;
		const doneEvent: AgentEvent = {
			type: "done",
			conversationId: "c",
			turnId: "t",
			reason: "completed",
		};
		const fakeFetch = async (
			_url: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			capturedBody = init?.body as string;
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(encoder.encode(`${JSON.stringify(doneEvent)}\n`));
					controller.close();
				},
			});
			return new Response(stream, { status: 200 });
		};

		await streamChat(
			{ fetchImpl: fakeFetch as unknown as typeof fetch },
			{
				server: "http://localhost:24203",
				request: { message: "hi" },
			},
		);

		expect(capturedBody).toBeDefined();
		const parsed = JSON.parse(capturedBody as string) as ChatRequest;
		expect(parsed).not.toHaveProperty("reasoningEffort");
	});
});

describe("fetchModels", () => {
	it("returns ModelsResponse on success", async () => {
		const models = { models: ["openai/gpt-4", "anthropic/claude-3"] };
		const fakeFetch = (async (): Promise<Response> =>
			new Response(JSON.stringify(models), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;

		const result = await fetchModels(
			{ fetchImpl: fakeFetch },
			{ server: "http://localhost:24203" },
		);
		expect(result).toEqual(models);
	});

	it("throws on non-OK status", async () => {
		const fakeFetch = (async (): Promise<Response> =>
			new Response("server error", { status: 500 })) as unknown as typeof fetch;

		await expect(
			fetchModels({ fetchImpl: fakeFetch }, { server: "http://localhost:24203" }),
		).rejects.toThrow("GET /models failed with status 500");
	});
});
