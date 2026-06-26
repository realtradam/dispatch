import { createLogger, type ToolExecuteContext } from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import { getTodos, type TodoState } from "./pure.js";
import { createTodoWriteTool } from "./tool.js";

function stubCtx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
  return {
    toolCallId: "test-call-1",
    onOutput: () => {},
    signal: new AbortController().signal,
    log: createLogger(
      { extensionId: "test" },
      { emit: () => {} },
      { now: () => 0, newId: () => "id" },
    ),
    ...overrides,
  };
}

describe("todo_write", () => {
  it("todo_write: replaces list + returns JSON result", async () => {
    const state: TodoState = new Map();
    const notify = vi.fn();
    const tool = createTodoWriteTool({ state, notify });
    const todos = [
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
    ];
    const result = await tool.execute({ todos }, stubCtx({ conversationId: "c1" }));
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(JSON.stringify(todos, null, 2));
    expect(getTodos(state, "c1")).toEqual(todos);
  });

  it("todo_write: calls notify after write", async () => {
    const state: TodoState = new Map();
    const notify = vi.fn();
    const tool = createTodoWriteTool({ state, notify });
    expect(notify).not.toHaveBeenCalled();
    await tool.execute(
      { todos: [{ content: "x", status: "pending" }] },
      stubCtx({ conversationId: "c1" }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("todo_write: validation error returns isError", async () => {
    const state: TodoState = new Map();
    const notify = vi.fn();
    const tool = createTodoWriteTool({ state, notify });
    const result = await tool.execute(
      { todos: [{ content: "x", status: "bogus" }] },
      stubCtx({ conversationId: "c1" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
    expect(notify).not.toHaveBeenCalled();
  });

  it("todo_write: uses conversationId from ctx", async () => {
    const state: TodoState = new Map();
    const notify = vi.fn();
    const tool = createTodoWriteTool({ state, notify });
    await tool.execute(
      { todos: [{ content: "x", status: "pending" }] },
      stubCtx({ conversationId: "conv-42" }),
    );
    expect(getTodos(state, "conv-42")).toHaveLength(1);
    // a different conversation is unaffected
    expect(getTodos(state, "conv-other")).toEqual([]);
  });

  it("todo_write: errors when conversationId is absent", async () => {
    const state: TodoState = new Map();
    const notify = vi.fn();
    const tool = createTodoWriteTool({ state, notify });
    const result = await tool.execute({ todos: [{ content: "x", status: "pending" }] }, stubCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Error: no conversation context for todo.");
    expect(notify).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
  });

  it("todo_write: accepts empty array (clears list)", async () => {
    const state: TodoState = new Map();
    const notify = vi.fn();
    const tool = createTodoWriteTool({ state, notify });
    // seed
    await tool.execute(
      { todos: [{ content: "seed", status: "pending" }] },
      stubCtx({ conversationId: "c1" }),
    );
    expect(getTodos(state, "c1")).toHaveLength(1);
    // clear via empty list
    const result = await tool.execute({ todos: [] }, stubCtx({ conversationId: "c1" }));
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("[]");
    expect(getTodos(state, "c1")).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
