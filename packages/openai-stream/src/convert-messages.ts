import type { ChatMessage, Chunk } from "@dispatch/kernel";

/** A text part within a multimodal OpenAI content array. */
export interface OpenAITextPart {
  readonly type: "text";
  readonly text: string;
}

/** An image part within a multimodal OpenAI content array (OpenAI vision format). */
export interface OpenAIImagePart {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
}

/**
 * A part of a multimodal message content array. When a message has mixed text
 * and image chunks, the content is serialized as an array of these parts
 * (OpenAI's vision format). Plain-text messages keep a string `content` for
 * byte-stability with providers that only accept strings.
 */
export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

export interface OpenAIMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null | readonly OpenAIContentPart[];
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
  // If the message has image chunks, serialize as a multimodal content array
  // (OpenAI vision format): text parts + image_url parts in chunk order.
  // Plain text-only messages keep a string `content` for byte-stability with
  // providers that only accept a string (and to keep prompt-cache prefixes
  // unchanged for the common no-image case).
  const hasImage = msg.chunks.some((c) => c.type === "image");
  if (hasImage) {
    const parts: OpenAIContentPart[] = [];
    for (const chunk of msg.chunks) {
      if (chunk.type === "text") {
        if (chunk.text.length > 0) {
          parts.push({ type: "text", text: chunk.text });
        }
      } else if (chunk.type === "image") {
        parts.push({ type: "image_url", image_url: { url: chunk.url } });
      }
      // Non-text/non-image chunks (tool-call, thinking, etc.) are not part of a
      // user message's provider content and are skipped here.
    }
    // An image-only message (no text) still needs at least the image part.
    return { role: "user", content: parts.length > 0 ? parts : "" };
  }

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
          arguments: serializeToolArguments(c.input),
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

/**
 * Serialize a tool-call's `input` into a JSON string the provider will accept.
 *
 * The OpenAI `arguments` field MUST be a valid JSON string. A broken chat can
 * have a tool-call whose `input` is a raw malformed-JSON string (the model
 * emitted broken JSON as the tool arguments and it was stored verbatim).
 * Passing that string straight through makes the provider 400
 * `unexpected character` on EVERY continuation, bricking the chat.
 *
 * - object input → `JSON.stringify(input)` (regression, unchanged shape).
 * - string input that is valid JSON → re-serialized to canonical JSON.
 * - string input that fails to parse → a valid fallback object preserving a
 *   truncated hint of the original, so the chat can continue (the model sees
 *   its tool-call had no usable args and adjusts).
 *
 * Pure: input → output, no I/O.
 */
function serializeToolArguments(input: unknown): string {
  if (typeof input === "string") {
    try {
      return JSON.stringify(JSON.parse(input));
    } catch {
      return JSON.stringify({ _malformed_arguments: input.slice(0, 200) });
    }
  }
  return JSON.stringify(input);
}
