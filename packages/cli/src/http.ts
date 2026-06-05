/**
 * Shell — HTTP transport layer (effects injected at the edges).
 *
 * streamChat: POST /chat, returns an async iterable of AgentEvents.
 * fetchModels: GET /models, returns the ModelsResponse.
 *
 * The fetchImpl dependency is injected (outermost edge mock allowed).
 */

import type { AgentEvent, ChatRequest, ModelsResponse } from "@dispatch/transport-contract";
import { splitNdjsonLines } from "./ndjson.js";

interface FetchDeps {
	readonly fetchImpl: typeof fetch;
}

interface StreamChatOpts {
	readonly server: string;
	readonly request: ChatRequest;
}

export async function streamChat(
	deps: FetchDeps,
	opts: StreamChatOpts,
): Promise<{ conversationId: string | null; events: AsyncIterable<AgentEvent> }> {
	const url = `${opts.server}/chat`;
	const res = await deps.fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(opts.request),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`POST /chat failed with status ${res.status}: ${body}`);
	}

	const conversationId = res.headers.get("X-Conversation-Id");

	if (!res.body) {
		throw new Error("POST /chat returned no body");
	}

	const events = readNdjsonStream(res.body);
	return { conversationId, events };
}

async function* readNdjsonStream(body: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { lines, rest } = splitNdjsonLines(buffer);
			buffer = rest;
			for (const line of lines) {
				yield JSON.parse(line) as AgentEvent;
			}
		}
		if (buffer.length > 0) {
			yield JSON.parse(buffer) as AgentEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

interface FetchModelsOpts {
	readonly server: string;
}

export async function fetchModels(deps: FetchDeps, opts: FetchModelsOpts): Promise<ModelsResponse> {
	const url = `${opts.server}/models`;
	const res = await deps.fetchImpl(url);

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`GET /models failed with status ${res.status}: ${body}`);
	}

	return (await res.json()) as ModelsResponse;
}
