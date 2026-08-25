import type { ChatMessage } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import { countChunks, dedupeDuplicateToolChunks } from "./repair.js";

const call = (id: string): ChatMessage["chunks"][number] => ({
  type: "tool-call",
  toolCallId: id,
  toolName: `tool-${id}`,
  input: { id },
});

const result = (id: string): ChatMessage["chunks"][number] => ({
  type: "tool-result",
  toolCallId: id,
  toolName: `tool-${id}`,
  content: `result-${id}`,
  isError: false,
});

const msg = (chunks: ChatMessage["chunks"]): ChatMessage => ({ role: "assistant", chunks });

describe("dedupeDuplicateToolChunks", () => {
  it("keeps the first occurrence of each tool-call toolCallId and drops later duplicates", () => {
    const input = [msg([call("a"), call("b"), call("a"), call("b")])];
    const { messages, removedChunks, removedIds } = dedupeDuplicateToolChunks(input);
    expect(removedChunks).toBe(2);
    expect(removedIds).toEqual(["a", "b"]);
    expect(messages[0]?.chunks.map((c) => (c as { toolCallId: string }).toolCallId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("also dedupes duplicate tool-result chunks by toolCallId", () => {
    const input = [msg([result("a"), result("a"), result("b")])];
    const { messages, removedChunks } = dedupeDuplicateToolChunks(input);
    expect(removedChunks).toBe(1);
    expect(messages[0]?.chunks).toHaveLength(2);
  });

  it("leaves non-tool chunks untouched and preserves their order", () => {
    const input = [
      msg([
        { type: "text", text: "hello" },
        call("a"),
        { type: "thinking", text: "hmm" },
        call("b"),
        call("a"),
        { type: "image", url: "data:image/png;base64,AAA=" },
      ]),
    ];
    const { messages, removedChunks } = dedupeDuplicateToolChunks(input);
    expect(removedChunks).toBe(1);
    expect(messages[0]?.chunks.map((c) => c.type)).toEqual([
      "text",
      "tool-call",
      "thinking",
      "tool-call",
      "image",
    ]);
  });

  it("returns the original message reference when nothing is removed", () => {
    const input = [msg([call("a"), call("b")])];
    const { messages, removedChunks } = dedupeDuplicateToolChunks(input);
    expect(removedChunks).toBe(0);
    expect(messages[0]).toBe(input[0]);
  });

  it("dedupes independently per message (same id in different messages survives)", () => {
    const input = [msg([call("a")]), msg([call("a")])];
    const { messages, removedChunks, removedIds } = dedupeDuplicateToolChunks(input);
    expect(removedChunks).toBe(0);
    expect(removedIds).toEqual([]);
    expect(messages).toHaveLength(2);
  });

  it("countChunks totals all chunks", () => {
    expect(countChunks([msg([call("a"), result("a")]), msg([{ type: "text", text: "hi" }])])).toBe(
      3,
    );
  });
});
