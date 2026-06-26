import { describe, expect, it } from "vitest";
import { clearTodos, getTodos, setTodos, type TodoState } from "./pure.js";

describe("getTodos", () => {
  it("getTodos: returns fresh array copy (not the live array)", () => {
    const state: TodoState = new Map();
    setTodos(state, "c1", [{ content: "a", status: "pending" }]);
    const snap = getTodos(state, "c1");
    expect(snap).toHaveLength(1);
    // mutating the snapshot array does not affect live state
    snap.push({ content: "evil", status: "completed" });
    expect(getTodos(state, "c1")).toHaveLength(1);
  });

  it("getTodos: empty array for unknown conversation", () => {
    const state: TodoState = new Map();
    expect(getTodos(state, "nope")).toEqual([]);
  });
});

describe("setTodos", () => {
  it("setTodos: replaces the list and returns a copy", () => {
    const state: TodoState = new Map();
    setTodos(state, "c1", [{ content: "first", status: "pending" }]);
    // replace with a different list
    const snap = setTodos(state, "c1", [{ content: "second", status: "in_progress" }]);
    expect(snap).toHaveLength(1);
    const first = snap[0];
    if (first === undefined) throw new Error("expected an item");
    expect(first.content).toBe("second");
    // the previous list is gone
    expect(getTodos(state, "c1").map((t) => t.content)).toEqual(["second"]);
  });
});

describe("clearTodos", () => {
  it("clearTodos: deletes the conversation's list", () => {
    const state: TodoState = new Map();
    setTodos(state, "c1", [{ content: "x", status: "pending" }]);
    expect(getTodos(state, "c1")).toHaveLength(1);
    clearTodos(state, "c1");
    expect(getTodos(state, "c1")).toEqual([]);
    // a second clear is a no-op
    clearTodos(state, "c1");
    expect(getTodos(state, "c1")).toEqual([]);
  });
});
