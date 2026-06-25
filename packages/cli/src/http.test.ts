import type {
	AgentEvent,
	ChatRequest,
	ConversationListResponse,
} from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import {
	enqueueMessage,
	fetchConversations,
	fetchLastMessage,
	fetchModels,
	openConversation,
	resolveConversationId,
	streamChat,
} from "./http.js";

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

describe("fetchConversations", () => {
	it("requests GET /conversations with no query when query omitted", async () => {
		let calledUrl: string | undefined;
		const list: ConversationListResponse = {
			conversations: [
				{
					id: "abcdef1234567890",
					title: "first",
					createdAt: 1,
					lastActivityAt: 2,
					status: "idle",
					workspaceId: "default",
				},
			],
		};
		const fakeFetch = (async (url: string | URL | Request): Promise<Response> => {
			calledUrl = String(url);
			return new Response(JSON.stringify(list), { status: 200 });
		}) as unknown as typeof fetch;

		const result = await fetchConversations(
			{ fetchImpl: fakeFetch },
			{ server: "http://localhost:24203" },
		);
		expect(calledUrl).toBe("http://localhost:24203/conversations");
		expect(result).toEqual(list);
	});

	it("appends ?q=<encoded> when a query is given", async () => {
		let calledUrl: string | undefined;
		const fakeFetch = (async (url: string | URL | Request): Promise<Response> => {
			calledUrl = String(url);
			return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
		}) as unknown as typeof fetch;

		await fetchConversations(
			{ fetchImpl: fakeFetch },
			{ server: "http://localhost:24203", query: "abc def" },
		);
		expect(calledUrl).toBe("http://localhost:24203/conversations?q=abc+def");
	});

	it("appends ?workspaceId=<value> when a workspaceId is given", async () => {
		let calledUrl: string | undefined;
		const fakeFetch = (async (url: string | URL | Request): Promise<Response> => {
			calledUrl = String(url);
			return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
		}) as unknown as typeof fetch;

		await fetchConversations(
			{ fetchImpl: fakeFetch },
			{ server: "http://localhost:24203", workspaceId: "proj" },
		);
		expect(calledUrl).toBe("http://localhost:24203/conversations?workspaceId=proj");
	});

	it("combines ?status= and ?workspaceId= when both are given", async () => {
		let calledUrl: string | undefined;
		const fakeFetch = (async (url: string | URL | Request): Promise<Response> => {
			calledUrl = String(url);
			return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
		}) as unknown as typeof fetch;

		await fetchConversations(
			{ fetchImpl: fakeFetch },
			{ server: "http://localhost:24203", status: "active,idle", workspaceId: "proj" },
		);
		expect(calledUrl).toBe(
			"http://localhost:24203/conversations?status=active%2Cidle&workspaceId=proj",
		);
	});

	it("throws on non-OK status", async () => {
		const fakeFetch = (async (): Promise<Response> =>
			new Response("boom", { status: 500 })) as unknown as typeof fetch;
		await expect(
			fetchConversations({ fetchImpl: fakeFetch }, { server: "http://localhost:24203" }),
		).rejects.toThrow("GET /conversations failed with status 500");
	});
});

describe("fetchLastMessage", () => {
	it("requests GET /conversations/:id/last and returns the body", async () => {
		let calledUrl: string | undefined;
		const fakeFetch = (async (url: string | URL | Request): Promise<Response> => {
			calledUrl = String(url);
			return new Response(
				JSON.stringify({ conversationId: "c1", content: "hello back", turnId: "t1" }),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const result = await fetchLastMessage(
			{ fetchImpl: fakeFetch },
			{ server: "http://localhost:24203", conversationId: "c1" },
		);
		expect(calledUrl).toBe("http://localhost:24203/conversations/c1/last");
		expect(result).toEqual({ conversationId: "c1", content: "hello back", turnId: "t1" });
	});

	it("throws on non-OK status", async () => {
		const fakeFetch = (async (): Promise<Response> =>
			new Response("nope", { status: 404 })) as unknown as typeof fetch;
		await expect(
			fetchLastMessage(
				{ fetchImpl: fakeFetch },
				{ server: "http://localhost:24203", conversationId: "c1" },
			),
		).rejects.toThrow("GET /conversations/:id/last failed with status 404");
	});
});

describe("enqueueMessage", () => {
	it("POSTs to /conversations/:id/queue with { text } and returns the body", async () => {
		let calledUrl: string | undefined;
		let calledInit: RequestInit | undefined;
		const fakeFetch = (async (
			url: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			calledUrl = String(url);
			calledInit = init;
			return new Response(JSON.stringify({ conversationId: "c1", startedTurn: false, queue: [] }), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		const result = await enqueueMessage(
			{ fetchImpl: fakeFetch },
			{ server: "http://localhost:24203", conversationId: "c1", text: "hi" },
		);
		expect(calledUrl).toBe("http://localhost:24203/conversations/c1/queue");
		expect(calledInit?.method).toBe("POST");
		expect(JSON.parse(calledInit?.body as string)).toEqual({ text: "hi" });
		expect(result).toEqual({ conversationId: "c1", startedTurn: false, queue: [] });
	});

	it("throws on non-OK status", async () => {
		const fakeFetch = (async (): Promise<Response> =>
			new Response("bad", { status: 400 })) as unknown as typeof fetch;
		await expect(
			enqueueMessage(
				{ fetchImpl: fakeFetch },
				{ server: "http://localhost:24203", conversationId: "c1", text: "hi" },
			),
		).rejects.toThrow("POST /conversations/:id/queue failed with status 400");
	});
});

describe("openConversation", () => {
	it("POSTs to /conversations/:id/open and returns the body", async () => {
		let calledUrl: string | undefined;
		let calledInit: RequestInit | undefined;
		const fakeFetch = (async (
			url: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			calledUrl = String(url);
			calledInit = init;
			return new Response(JSON.stringify({ conversationId: "c1" }), { status: 200 });
		}) as unknown as typeof fetch;

		const result = await openConversation(
			{ fetchImpl: fakeFetch },
			{ server: "http://localhost:24203", conversationId: "c1" },
		);
		expect(calledUrl).toBe("http://localhost:24203/conversations/c1/open");
		expect(calledInit?.method).toBe("POST");
		expect(result).toEqual({ conversationId: "c1" });
	});

	it("throws on non-OK status", async () => {
		const fakeFetch = (async (): Promise<Response> =>
			new Response("bad", { status: 500 })) as unknown as typeof fetch;
		await expect(
			openConversation(
				{ fetchImpl: fakeFetch },
				{ server: "http://localhost:24203", conversationId: "c1" },
			),
		).rejects.toThrow("POST /conversations/:id/open failed with status 500");
	});
});

describe("resolveConversationId", () => {
	function listFetch(list: ConversationListResponse): typeof fetch {
		return (async (): Promise<Response> =>
			new Response(JSON.stringify(list), { status: 200 })) as unknown as typeof fetch;
	}

	it("returns the full id on a single match", async () => {
		const fetchImpl = listFetch({
			conversations: [
				{
					id: "abcdef1234567890abcdef1234567890",
					title: "only",
					createdAt: 1,
					lastActivityAt: 2,
					status: "idle",
					workspaceId: "default",
				},
			],
		});
		const result = await resolveConversationId(
			{ fetchImpl },
			{ server: "http://localhost:24203", shortId: "abcdef" },
		);
		expect(result).toBe("abcdef1234567890abcdef1234567890");
	});

	it("returns an error object on no match", async () => {
		const fetchImpl = listFetch({ conversations: [] });
		const result = await resolveConversationId(
			{ fetchImpl },
			{ server: "http://localhost:24203", shortId: "abcdef" },
		);
		expect(typeof result).toBe("object");
		if (typeof result !== "string") {
			expect(result.error).toContain("No conversation matching");
			expect(result.error).toContain("abcdef");
		}
	});

	it("returns an error object listing matches on multiple matches", async () => {
		const fetchImpl = listFetch({
			conversations: [
				{
					id: "abcdef1234567890aaaaaaaaaaaaaaaa",
					title: "first",
					createdAt: 1,
					lastActivityAt: 2,
					status: "idle",
					workspaceId: "default",
				},
				{
					id: "abcdef1234567890bbbbbbbbbbbbbbbb",
					title: "second",
					createdAt: 1,
					lastActivityAt: 3,
					status: "idle",
					workspaceId: "default",
				},
			],
		});
		const result = await resolveConversationId(
			{ fetchImpl },
			{ server: "http://localhost:24203", shortId: "abcdef" },
		);
		expect(typeof result).toBe("object");
		if (typeof result !== "string") {
			expect(result.error).toContain("Multiple conversations matching");
			expect(result.error).toContain("abcdef12");
			expect(result.error).toContain("first");
			expect(result.error).toContain("second");
		}
	});

	it("passes through a full UUID (32+ chars) without calling fetch", async () => {
		const fetchImpl = (async (): Promise<Response> => {
			throw new Error("fetch must not be called for a full UUID");
		}) as unknown as typeof fetch;
		const fullId = "abcdef1234567890abcdef1234567890";
		const result = await resolveConversationId(
			{ fetchImpl },
			{ server: "http://localhost:24203", shortId: fullId },
		);
		expect(result).toBe(fullId);
	});
});
