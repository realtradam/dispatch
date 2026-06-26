import { describe, expect, it } from "vitest";
import { validateTodos } from "./pure.js";

describe("validateTodos", () => {
  it("validateTodos: accepts valid list", () => {
    const result = validateTodos({
      todos: [
        { content: "Do thing A", status: "pending" },
        { content: "Do thing B", status: "in_progress" },
        { content: "Do thing C", status: "completed" },
      ],
    });
    expect(result).toEqual([
      { content: "Do thing A", status: "pending" },
      { content: "Do thing B", status: "in_progress" },
      { content: "Do thing C", status: "completed" },
    ]);
  });

  it("validateTodos: accepts empty array (clears the list)", () => {
    const result = validateTodos({ todos: [] });
    expect(result).toEqual([]);
  });

  it("validateTodos: rejects invalid status", () => {
    const result = validateTodos({
      todos: [{ content: "x", status: "bogus" }],
    });
    expect(result).toHaveProperty("error");
  });

  it("validateTodos: rejects empty content", () => {
    const empty = validateTodos({
      todos: [{ content: "", status: "pending" }],
    });
    expect(empty).toHaveProperty("error");
    const whitespace = validateTodos({
      todos: [{ content: "   ", status: "pending" }],
    });
    expect(whitespace).toHaveProperty("error");
  });

  it("validateTodos: rejects non-array todos", () => {
    const result = validateTodos({ todos: "not-an-array" });
    expect(result).toHaveProperty("error");
  });

  it("validateTodos: rejects null/non-object args", () => {
    expect(validateTodos(null)).toHaveProperty("error");
    expect(validateTodos(undefined)).toHaveProperty("error");
    expect(validateTodos("string")).toHaveProperty("error");
    expect(validateTodos(42)).toHaveProperty("error");
    expect(validateTodos([])).toHaveProperty("error");
  });

  it("validateTodos: does NOT enforce one in_progress (allows multiple — description guides the model)", () => {
    const result = validateTodos({
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });
});
