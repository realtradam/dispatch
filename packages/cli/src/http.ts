/**
 * Shell — HTTP transport layer (effects injected at the edges).
 *
 * streamChat: POST /chat, returns an async iterable of AgentEvents.
 * fetchModels: GET /models, returns the ModelsResponse.
 *
 * The fetchImpl dependency is injected (outermost edge mock allowed).
 */

import type {
	AgentEvent,
	ChatRequest,
	CompactResponse,
	ConversationListResponse,
	LastMessageResponse,
	ModelsResponse,
	OpenConversationResponse,
	QueueResponse,
} from "@dispatch/transport-contract";
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

interface FetchConversationsOpts {
	readonly server: string;
	readonly query?: string;
	readonly status?: string;
	readonly workspaceId?: string;
}

export async function fetchConversations(
	deps: FetchDeps,
	opts: FetchConversationsOpts,
): Promise<ConversationListResponse> {
	const params = new URLSearchParams();
	if (opts.query !== undefined) params.set("q", opts.query);
	if (opts.status !== undefined) params.set("status", opts.status);
	if (opts.workspaceId !== undefined) params.set("workspaceId", opts.workspaceId);
	const qs = params.toString();
	const url = qs.length > 0 ? `${opts.server}/conversations?${qs}` : `${opts.server}/conversations`;
	const res = await deps.fetchImpl(url);

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`GET /conversations failed with status ${res.status}: ${body}`);
	}

	return (await res.json()) as ConversationListResponse;
}

interface FetchLastMessageOpts {
	readonly server: string;
	readonly conversationId: string;
}

export async function fetchLastMessage(
	deps: FetchDeps,
	opts: FetchLastMessageOpts,
): Promise<LastMessageResponse> {
	const url = `${opts.server}/conversations/${encodeURIComponent(opts.conversationId)}/last`;
	const res = await deps.fetchImpl(url);

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`GET /conversations/:id/last failed with status ${res.status}: ${body}`);
	}

	return (await res.json()) as LastMessageResponse;
}

interface EnqueueMessageOpts {
	readonly server: string;
	readonly conversationId: string;
	readonly text: string;
}

export async function enqueueMessage(
	deps: FetchDeps,
	opts: EnqueueMessageOpts,
): Promise<QueueResponse> {
	const url = `${opts.server}/conversations/${encodeURIComponent(opts.conversationId)}/queue`;
	const res = await deps.fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: opts.text }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`POST /conversations/:id/queue failed with status ${res.status}: ${body}`);
	}

	return (await res.json()) as QueueResponse;
}

interface OpenConversationOpts {
	readonly server: string;
	readonly conversationId: string;
}

export async function openConversation(
	deps: FetchDeps,
	opts: OpenConversationOpts,
): Promise<OpenConversationResponse> {
	const url = `${opts.server}/conversations/${encodeURIComponent(opts.conversationId)}/open`;
	const res = await deps.fetchImpl(url, { method: "POST" });

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`POST /conversations/:id/open failed with status ${res.status}: ${body}`);
	}

	return (await res.json()) as OpenConversationResponse;
}

interface CompactConversationOpts {
	readonly server: string;
	readonly conversationId: string;
}

export async function compactConversation(
	deps: FetchDeps,
	opts: CompactConversationOpts,
): Promise<CompactResponse> {
	const url = `${opts.server}/conversations/${encodeURIComponent(opts.conversationId)}/compact`;
	const res = await deps.fetchImpl(url, { method: "POST" });

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`POST /conversations/:id/compact failed with status ${res.status}: ${body}`);
	}

	return (await res.json()) as CompactResponse;
}

interface StopTurnOpts {
	readonly server: string;
	readonly conversationId: string;
}

export async function stopTurn(
	deps: FetchDeps,
	opts: StopTurnOpts,
): Promise<{ conversationId: string; abortedTurn: boolean }> {
	const url = `${opts.server}/conversations/${encodeURIComponent(opts.conversationId)}/stop`;
	const res = await deps.fetchImpl(url, { method: "POST" });

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`POST /conversations/:id/stop failed with status ${res.status}: ${body}`);
	}

	return (await res.json()) as { conversationId: string; abortedTurn: boolean };
}

/**
 * The outcome of short-ID resolution: either the full conversation id to use,
 * or a human-readable error describing why resolution failed.
 */
export type ConversationIdResolution = string | { readonly error: string };

interface ResolveConversationIdOpts {
	readonly server: string;
	readonly shortId: string;
}

/**
 * Resolve a user-typed conversation prefix to a full id. A 32+ char input is
 * assumed to be a full UUID and returned untouched. Otherwise the conversation
 * list is filtered by the prefix: 1 match → its id; 0 → error; >1 → error with
 * the candidate short ids + titles so the user can disambiguate.
 */
export async function resolveConversationId(
	deps: FetchDeps,
	opts: ResolveConversationIdOpts,
): Promise<ConversationIdResolution> {
	if (opts.shortId.length >= 32) {
		return opts.shortId;
	}

	const list = await fetchConversations(deps, { server: opts.server, query: opts.shortId });
	const matches = list.conversations;

	if (matches.length === 0) {
		return { error: `No conversation matching "${opts.shortId}"` };
	}

	if (matches.length === 1) {
		const only = matches[0];
		if (only === undefined) return { error: `No conversation matching "${opts.shortId}"` };
		return only.id;
	}

	const lines = matches.map((m) => `${m.id.slice(0, 8)}  ${m.title}`).join("\n");
	return {
		error: `Multiple conversations matching "${opts.shortId}"\n${lines}`,
	};
}
