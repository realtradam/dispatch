import { z } from "zod";
import type { TaskItem, TaskStatus, ToolDefinition } from "../types/index.js";

/**
 * Valid task statuses. Matches opencode's todo lifecycle:
 *   - pending     not started
 *   - in_progress actively working (exactly ONE at a time)
 *   - completed   finished successfully
 *   - cancelled   no longer needed
 */
const VALID_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	"pending",
	"in_progress",
	"completed",
	"cancelled",
]);

function normalizeStatus(value: unknown): TaskStatus {
	return typeof value === "string" && VALID_STATUSES.has(value as TaskStatus)
		? (value as TaskStatus)
		: "pending";
}

/**
 * Declarative, whole-list task store (ported from opencode's `todowrite`).
 *
 * The model never sees ids and never issues per-item mutations. Instead it
 * sends the ENTIRE desired list on every call and {@link setTasks} rebuilds the
 * stored list, assigning fresh positional ids. This is idempotent and
 * eliminates the id-bookkeeping / "task not found" / delta-reasoning failure
 * modes of the old imperative CRUD interface.
 */
export class TaskList {
	private tasks: TaskItem[] = [];
	private listeners: Array<(tasks: TaskItem[]) => void> = [];

	private notify(): void {
		const snapshot = this.getTasks();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}

	getTasks(): TaskItem[] {
		return this.tasks.map((t) => ({ ...t }));
	}

	/**
	 * Replace the entire list. Each item is assigned a fresh positional id
	 * (`task-1`, `task-2`, …). Invalid/missing statuses fall back to
	 * `pending`; an empty array clears the list. Always notifies listeners.
	 */
	setTasks(items: Array<{ content: string; status?: unknown }>): TaskItem[] {
		this.tasks = items.map((item, index) => ({
			id: `task-${index + 1}`,
			content: item.content,
			status: normalizeStatus(item.status),
		}));
		this.notify();
		return this.getTasks();
	}

	onChange(callback: (tasks: TaskItem[]) => void): () => void {
		this.listeners.push(callback);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== callback);
		};
	}
}

/**
 * Rich tool description adapted from opencode's `todowrite.txt`. Teaches the
 * declarative whole-list cadence and the status lifecycle.
 */
export const TODO_DESCRIPTION = `Create and maintain a structured todo list for the current session to track progress and surface your plan to the user.

This is a DECLARATIVE, whole-list tool. There are no ids and no per-item actions: every call sends the ENTIRE list in the \`todos\` parameter and REPLACES the previous list. To change one item, resend the whole list with that item changed. To clear the list, send an empty array.

## When to use
- The task requires 3+ distinct steps and benefits from planning
- The user provides multiple tasks (numbered or comma-separated) or asks for a todo list
- New instructions arrive — capture them as todos
- You start a task — mark it in_progress (only one at a time) before working
- You finish a task — mark it completed and add any follow-ups discovered

## When NOT to use
- A single, straightforward task (or fewer than 3 trivial steps)
- Purely informational or conversational requests
- When tracking adds no organizational value

## States
- pending — not started
- in_progress — actively working (exactly ONE at a time)
- completed — finished successfully
- cancelled — no longer needed

## Rules
- Send the full desired list every time; the tool replaces the stored list
- Update status in real time; do not batch completions
- Mark completed only after the work is actually done (including any required verification), never on intent
- Keep exactly one in_progress while work remains
- If blocked or partial, keep it in_progress and add a follow-up todo describing the blocker
- Items should be specific and actionable; break large work into smaller steps`;

export function createTaskListTool(taskList: TaskList): ToolDefinition {
	return {
		name: "todo",
		description: TODO_DESCRIPTION,
		parameters: z.object({
			todos: z
				.array(
					z.object({
						content: z.string().describe("Brief, actionable description of the task"),
						status: z
							.enum(["pending", "in_progress", "completed", "cancelled"])
							.describe("Current status of the task"),
					}),
				)
				.describe("The complete, updated todo list. Replaces the previous list entirely."),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const rawTodos = args.todos;
			if (!Array.isArray(rawTodos)) {
				return "Error: 'todos' must be an array of { content, status } items (send the whole list).";
			}

			const items: Array<{ content: string; status?: unknown }> = [];
			for (const entry of rawTodos) {
				if (!entry || typeof entry !== "object") {
					return "Error: each todo must be an object with a 'content' string and a 'status'.";
				}
				const content = (entry as Record<string, unknown>).content;
				if (typeof content !== "string" || content.trim() === "") {
					return "Error: each todo requires a non-empty 'content' string.";
				}
				items.push({
					content,
					status: (entry as Record<string, unknown>).status,
				});
			}

			const stored = taskList.setTasks(items);
			// Echo the canonical stored list back WITHOUT ids — the model must
			// never start tracking ids; it always resends the whole list.
			const echo = stored.map((t) => ({ content: t.content, status: t.status }));
			return JSON.stringify(echo);
		},
	};
}
