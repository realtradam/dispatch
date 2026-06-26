import type { ChatMessage, StepId } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { reconcile, reconcileWithReport } from "./reconcile.js";

describe("reconcile", () => {
  it("returns empty array for empty input", () => {
    expect(reconcile([])).toEqual([]);
  });

  it("passes through a complete conversation unchanged", () => {
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "text", text: "hello" }] },
      { role: "assistant", chunks: [{ type: "text", text: "hi there" }] },
    ];
    const result = reconcile(messages);
    expect(result).toEqual(messages);
  });

  it("passes through a complete tool-call/tool-result pair unchanged", () => {
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "text", text: "read file" }] },
      {
        role: "assistant",
        chunks: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "readFile",
            input: { path: "/tmp/foo" },
          },
        ],
      },
      {
        role: "tool",
        chunks: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "readFile",
            content: "file contents",
            isError: false,
          },
        ],
      },
      { role: "assistant", chunks: [{ type: "text", text: "done" }] },
    ];
    const result = reconcile(messages);
    expect(result).toEqual(messages);
  });

  it("synthesizes error result for orphaned tool-call", () => {
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "text", text: "do something" }] },
      {
        role: "assistant",
        chunks: [
          {
            type: "tool-call",
            toolCallId: "call_orphan",
            toolName: "someTool",
            input: {},
          },
        ],
      },
    ];
    const result = reconcile(messages);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      role: "tool",
      chunks: [
        {
          type: "tool-result",
          toolCallId: "call_orphan",
          toolName: "someTool",
          content: "interrupted: tool execution did not complete",
          isError: true,
        },
      ],
    });
  });

  it("synthesizes results for multiple orphaned tool-calls", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        chunks: [
          {
            type: "tool-call",
            toolCallId: "call_a",
            toolName: "toolA",
            input: {},
          },
          {
            type: "tool-call",
            toolCallId: "call_b",
            toolName: "toolB",
            input: {},
          },
        ],
      },
    ];
    const result = reconcile(messages);
    expect(result).toHaveLength(3);
    expect(result[1]?.role).toBe("tool");
    expect(result[2]?.role).toBe("tool");
    const ids = result.slice(1).map((m) => {
      const chunk = m.chunks[0];
      return chunk?.type === "tool-result" ? chunk.toolCallId : null;
    });
    expect(ids).toEqual(["call_a", "call_b"]);
  });

  it("handles mixed resolved and orphaned tool-calls", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        chunks: [
          {
            type: "tool-call",
            toolCallId: "call_resolved",
            toolName: "toolResolved",
            input: {},
          },
          {
            type: "tool-call",
            toolCallId: "call_orphan",
            toolName: "toolOrphan",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        chunks: [
          {
            type: "tool-result",
            toolCallId: "call_resolved",
            toolName: "toolResolved",
            content: "ok",
            isError: false,
          },
        ],
      },
    ];
    const result = reconcile(messages);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      role: "tool",
      chunks: [
        {
          type: "tool-result",
          toolCallId: "call_orphan",
          toolName: "toolOrphan",
          content: "interrupted: tool execution did not complete",
          isError: true,
        },
      ],
    });
  });

  it("handles multiple turns with orphaned tool-calls in different turns", () => {
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "text", text: "turn 1" }] },
      {
        role: "assistant",
        chunks: [
          {
            type: "tool-call",
            toolCallId: "call_t1",
            toolName: "tool1",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        chunks: [
          {
            type: "tool-result",
            toolCallId: "call_t1",
            toolName: "tool1",
            content: "result",
            isError: false,
          },
        ],
      },
      { role: "user", chunks: [{ type: "text", text: "turn 2" }] },
      {
        role: "assistant",
        chunks: [
          {
            type: "tool-call",
            toolCallId: "call_t2",
            toolName: "tool2",
            input: {},
          },
        ],
      },
    ];
    const result = reconcile(messages);
    expect(result).toHaveLength(6);
    expect(result[5]).toEqual({
      role: "tool",
      chunks: [
        {
          type: "tool-result",
          toolCallId: "call_t2",
          toolName: "tool2",
          content: "interrupted: tool execution did not complete",
          isError: true,
        },
      ],
    });
  });

  it("preserves thinking and text chunks alongside tool-calls", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        chunks: [
          { type: "thinking", text: "let me think" },
          { type: "text", text: "I will call a tool" },
          {
            type: "tool-call",
            toolCallId: "call_x",
            toolName: "toolX",
            input: { a: 1 },
          },
        ],
      },
    ];
    const result = reconcile(messages);
    expect(result).toHaveLength(2);
    expect(result[0]?.chunks).toHaveLength(3);
    expect(result[1]?.role).toBe("tool");
  });

  it("copies the originating tool-call's stepId onto a synthesized result", () => {
    const stepId = "step_orphan" as StepId;
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        chunks: [
          {
            type: "tool-call",
            toolCallId: "call_sid",
            toolName: "someTool",
            input: {},
            stepId,
          },
        ],
      },
    ];
    const result = reconcile(messages);
    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("tool");
    const chunk = result[1]?.chunks[0];
    if (chunk === undefined) throw new Error("expected chunk");
    expect(chunk.type).toBe("tool-result");
    if (chunk.type === "tool-result") {
      expect(chunk.stepId).toBe(stepId);
    }
  });

  it("omits stepId when the dangling call has none", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        chunks: [
          {
            type: "tool-call",
            toolCallId: "call_nosid",
            toolName: "someTool",
            input: {},
          },
        ],
      },
    ];
    const result = reconcile(messages);
    expect(result).toHaveLength(2);
    const chunk = result[1]?.chunks[0];
    if (chunk === undefined) throw new Error("expected chunk");
    expect(chunk.type).toBe("tool-result");
    if (chunk.type === "tool-result") {
      expect(chunk).not.toHaveProperty("stepId");
    }
  });

  // --- Layer 1: read-time self-repair of broken chats (error chunks) ---

  it("reconcile strips error-only trailing assistant message", () => {
    // The 77574596/102587c0 shape: [user, assistant{error}] -> [user].
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "text", text: "hi" }] },
      { role: "assistant", chunks: [{ type: "error", message: "boom" }] },
    ];
    const { messages: result, report } = reconcileWithReport(messages);
    expect(result).toEqual([{ role: "user", chunks: [{ type: "text", text: "hi" }] }]);
    expect(report.strippedErrorChunks).toBe(1);
    expect(report.droppedEmptyMessages).toBe(1);
    expect(report.repairedCount).toBe(0);
  });

  it("reconcile strips error chunk but keeps sibling text", () => {
    // assistant{text,error} -> assistant{text}.
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        chunks: [
          { type: "text", text: "hello" },
          { type: "error", message: "boom" },
        ],
      },
    ];
    const { messages: result, report } = reconcileWithReport(messages);
    expect(result).toEqual([{ role: "assistant", chunks: [{ type: "text", text: "hello" }] }]);
    expect(report.strippedErrorChunks).toBe(1);
    expect(report.droppedEmptyMessages).toBe(0);
    expect(report.repairedCount).toBe(0);
  });

  it("reconcile drops assistant message left empty after stripping error", () => {
    // assistant{error} only -> dropped entirely.
    const messages: ChatMessage[] = [
      { role: "assistant", chunks: [{ type: "error", message: "boom" }] },
    ];
    const { messages: result, report } = reconcileWithReport(messages);
    expect(result).toEqual([]);
    expect(report.strippedErrorChunks).toBe(1);
    expect(report.droppedEmptyMessages).toBe(1);
    expect(report.repairedCount).toBe(0);
  });

  it("reconcile keeps tool-call + strips error", () => {
    // assistant{tool-call,error} with a matching result -> assistant{tool-call}.
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        chunks: [
          { type: "tool-call", toolCallId: "call_1", toolName: "t", input: {} },
          { type: "error", message: "boom" },
        ],
      },
      {
        role: "tool",
        chunks: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "t",
            content: "ok",
            isError: false,
          },
        ],
      },
    ];
    const { messages: result, report } = reconcileWithReport(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        chunks: [{ type: "tool-call", toolCallId: "call_1", toolName: "t", input: {} }],
      },
      {
        role: "tool",
        chunks: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "t",
            content: "ok",
            isError: false,
          },
        ],
      },
    ]);
    expect(report.strippedErrorChunks).toBe(1);
    expect(report.droppedEmptyMessages).toBe(0);
    expect(report.repairedCount).toBe(0); // the tool-call has a matching result
  });

  it("reconcile strips error and still synthesizes a result for an orphaned tool-call", () => {
    // Ordering guard: strip error chunks first, then run orphaned-tool-call
    // synthesis on what remains. assistant{tool-call,error} with NO result ->
    // the error is stripped, the tool-call survives, and a result is synthesized.
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        chunks: [
          { type: "tool-call", toolCallId: "call_orph", toolName: "t", input: {} },
          { type: "error", message: "boom" },
        ],
      },
    ];
    const { messages: result, report } = reconcileWithReport(messages);
    expect(result).toEqual([
      { role: "user", chunks: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        chunks: [{ type: "tool-call", toolCallId: "call_orph", toolName: "t", input: {} }],
      },
      {
        role: "tool",
        chunks: [
          {
            type: "tool-result",
            toolCallId: "call_orph",
            toolName: "t",
            content: "interrupted: tool execution did not complete",
            isError: true,
          },
        ],
      },
    ]);
    expect(report.strippedErrorChunks).toBe(1);
    expect(report.droppedEmptyMessages).toBe(0);
    expect(report.repairedCount).toBe(1);
    expect(report.repairedToolCallIds).toEqual(["call_orph"]);
  });
});
