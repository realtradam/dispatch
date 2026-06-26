/**
 * Pure core for todo — zero I/O, zero ambient state.
 *
 * Every function is input → output; testable without mocks. State is a plain
 * `Map<conversationId, TodoItem[]>` OWNED by the caller (the extension
 * shell); the pure functions mutate it in place and return snapshots (fresh
 * array copies), so a caller can never reach into or mutate live state through
 * a returned value. Mirrors message-queue's `pure.ts`.
 *
 * The `todo_write` tool VALIDATES SHAPE ONLY — it does not enforce business
 * rules like "exactly one in_progress". The tool description guides the model;
 * the validator checks that `args` is an object with a `todos` array whose
 * items each have a non-empty `content` and valid `status`/`priority` enums.
 * (Same posture as opencode's `todowrite`.)
 */

import type { CustomField, SurfaceSpec } from "@dispatch/ui-contract";

/** A todo item's lifecycle state. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/**
 * A single todo item. Identity is the array index (no `id`), per the opencode
 * pattern — the model passes the FULL list each call, so position is identity.
 */
export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

/** The todo store: a per-conversation map of todo lists. */
export type TodoState = Map<string, TodoItem[]>;

/** Surface id this extension contributes (also the manifest + catalog id). */
export const TODO_SURFACE_ID = "todo";
/** The custom renderer id a frontend switches on to render the todo list. */
export const TODO_RENDERER_ID = "todo";

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

/** Result of `validateTodos`: the validated list, or an error message. */
export type ValidationResult = TodoItem[] | { readonly error: string };

/**
 * Validate the `todo_write` tool's input SHAPE only — not business rules (the
 * tool description guides the model: "one in_progress at a time" etc.). Accepts
 * an empty array (the model clears the list). Pure: no I/O, no ambient state.
 */
export function validateTodos(args: unknown): ValidationResult {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { error: "Error: todo_write args must be an object with a `todos` array." };
  }
  const todos = (args as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) {
    return { error: "Error: `todos` must be an array." };
  }
  const validated: TodoItem[] = [];
  for (let i = 0; i < todos.length; i++) {
    const item = todos[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { error: `Error: todos[${i}] must be an object.` };
    }
    const { content, status } = item as {
      content?: unknown;
      status?: unknown;
    };
    if (typeof content !== "string" || content.trim().length === 0) {
      return { error: `Error: todos[${i}].content must be a non-empty string.` };
    }
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
      return {
        error: `Error: todos[${i}].status must be one of pending|in_progress|completed|cancelled.`,
      };
    }
    validated.push({
      content,
      status: status as TodoStatus,
    });
  }
  return validated;
}

/**
 * Current todo-list snapshot for a conversation — a fresh array copy. Empty
 * array if the conversation has no list / is unknown. Mutating the returned
 * array does not affect live state (items are readonly).
 */
export function getTodos(state: TodoState, conversationId: string): TodoItem[] {
  const existing = state.get(conversationId);
  if (existing === undefined) return [];
  return [...existing];
}

/**
 * Replace a conversation's todo list with `todos` (full-list replace — the
 * opencode pattern: the model passes the complete list each call). Mutates
 * `state` and returns a fresh array copy of the new list. The caller cannot
 * mutate live state through the returned value.
 */
export function setTodos(
  state: TodoState,
  conversationId: string,
  todos: readonly TodoItem[],
): TodoItem[] {
  state.set(conversationId, [...todos]);
  return getTodos(state, conversationId);
}

/** Delete a conversation's todo list. No-op if the conversation has none. */
export function clearTodos(state: TodoState, conversationId: string): void {
  state.delete(conversationId);
}

/**
 * Build the per-conversation surface spec: a single `custom` field whose
 * payload is the current todo snapshot (`{ todos }`). An empty `todos` array
 * (idle / cleared conversation) renders as an empty list. Pure — no I/O; the
 * surface-registry re-fetches this on every notify. Mirrors `buildQueueSpec`.
 */
export function buildTodoSpec(todos: readonly TodoItem[]): SurfaceSpec {
  const payload: { todos: readonly TodoItem[] } = { todos };
  const field: CustomField = {
    kind: "custom",
    rendererId: TODO_RENDERER_ID,
    payload,
  };
  return {
    id: TODO_SURFACE_ID,
    region: "side",
    title: "Tasks",
    fields: [field],
  };
}

/**
 * Format the todo list as the `todo_write` tool's result content: raw
 * pretty-printed JSON (the opencode pattern — `JSON.stringify(todos, null, 2)`),
 * not a custom human-readable format. The model parses prior writes from
 * conversation history, so it needs no separate read tool.
 */
export function formatTodoResult(todos: readonly TodoItem[]): string {
  return JSON.stringify(todos, null, 2);
}
