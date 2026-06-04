import type { ChatMessage, Chunk } from "@dispatch/kernel";

export interface OpenAIMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: string | null;
	readonly tool_calls?: readonly OpenAIToolCall[];
	readonly tool_call_id?: string;
}

export interface OpenAIToolCall {
	readonly id: string;
	readonly type: "function";
	readonly function: { readonly name: string; readonly arguments: string };
}

export function convertMessages(messages: readonly ChatMessage[]): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	for (const msg of messages) {
		const converted = convertMessage(msg);
		for (const m of converted) {
			result.push(m);
		}
	}
	return result;
}

function convertMessage(msg: ChatMessage): OpenAIMessage[] {
	switch (msg.role) {
		case "system":
			return [convertSystemMessage(msg)];
		case "user":
			return [convertUserMessage(msg)];
		case "assistant":
			return [convertAssistantMessage(msg)];
		case "tool":
			return convertToolResultMessages(msg);
	}
}

function convertSystemMessage(msg: ChatMessage): OpenAIMessage {
	const text = msg.chunks
		.filter(
			(c): c is Extract<Chunk, { type: "text" | "system" }> =>
				c.type === "text" || c.type === "system",
		)
		.map((c) => c.text)
		.join("");
	return { role: "system", content: text };
}

function convertUserMessage(msg: ChatMessage): OpenAIMessage {
	const text = msg.chunks
		.filter((c): c is Extract<Chunk, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("");
	return { role: "user", content: text };
}

function convertAssistantMessage(msg: ChatMessage): OpenAIMessage {
	const textChunks = msg.chunks.filter(
		(c): c is Extract<Chunk, { type: "text" | "thinking" }> =>
			c.type === "text" || c.type === "thinking",
	);
	const content = textChunks.map((c) => c.text).join("");

	const toolCalls = msg.chunks
		.filter((c): c is Extract<Chunk, { type: "tool-call" }> => c.type === "tool-call")
		.map(
			(c): OpenAIToolCall => ({
				id: c.toolCallId,
				type: "function",
				function: {
					name: c.toolName,
					arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input),
				},
			}),
		);

	if (toolCalls.length > 0) {
		return {
			role: "assistant",
			content: content || null,
			tool_calls: toolCalls,
		};
	}
	return { role: "assistant", content };
}

function convertToolResultMessages(msg: ChatMessage): OpenAIMessage[] {
	return msg.chunks
		.filter((c): c is Extract<Chunk, { type: "tool-result" }> => c.type === "tool-result")
		.map(
			(c): OpenAIMessage => ({
				role: "tool",
				content: c.content,
				tool_call_id: c.toolCallId,
			}),
		);
}
