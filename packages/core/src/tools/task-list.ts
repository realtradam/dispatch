import { z } from "zod";
import type { TaskItem, TaskStatus, ToolDefinition } from "../types/index.js";

export class TaskList {
	private tasks: TaskItem[] = [];
	private counter = 0;
	private listeners: Array<(tasks: TaskItem[]) => void> = [];

	private notify(): void {
		const snapshot = this.getTasks();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}

	getTasks(): TaskItem[] {
		return [...this.tasks];
	}

	getTask(id: string): TaskItem | undefined {
		return this.tasks.find((t) => t.id === id);
	}

	addTask(title: string, description: string): TaskItem {
		this.counter++;
		const task: TaskItem = {
			id: `task-${this.counter}`,
			title,
			description,
			status: "pending",
		};
		this.tasks.push(task);
		this.notify();
		return task;
	}

	updateTask(id: string, status: TaskStatus): TaskItem | undefined {
		const task = this.tasks.find((t) => t.id === id);
		if (!task) return undefined;
		task.status = status;
		this.notify();
		return { ...task };
	}

	removeTask(id: string): boolean {
		const index = this.tasks.findIndex((t) => t.id === id);
		if (index === -1) return false;
		this.tasks.splice(index, 1);
		this.notify();
		return true;
	}

	onChange(callback: (tasks: TaskItem[]) => void): () => void {
		this.listeners.push(callback);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== callback);
		};
	}
}

export function createTaskListTool(taskList: TaskList): ToolDefinition {
	return {
		name: "task_list",
		description:
			"Manages a task list for tracking work items. The agent can add tasks, update their status, list all tasks, or get details on a specific task.",
		parameters: z.object({
			action: z
				.enum(["add", "update", "list", "get", "remove"])
				.describe("The action to perform"),
			title: z.string().optional().describe("Task title (required for 'add')"),
			description: z
				.string()
				.optional()
				.describe("Task description (for 'add', defaults to empty)"),
			task_id: z
				.string()
				.optional()
				.describe("Task ID (required for 'update', 'get', 'remove')"),
			status: z
				.enum(["pending", "in_progress", "done", "blocked"])
				.optional()
				.describe("New status (required for 'update')"),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const action = args.action as string;

			if (action === "add") {
				const title = args.title as string | undefined;
				if (!title) {
					return "Error: 'title' is required for the 'add' action.";
				}
				const description = (args.description as string | undefined) ?? "";
				const task = taskList.addTask(title, description);
				return JSON.stringify(task);
			}

			if (action === "update") {
				const task_id = args.task_id as string | undefined;
				const status = args.status as TaskStatus | undefined;
				if (!task_id) {
					return "Error: 'task_id' is required for the 'update' action.";
				}
				if (!status) {
					return "Error: 'status' is required for the 'update' action.";
				}
				const updated = taskList.updateTask(task_id, status);
				if (!updated) {
					return `Error: Task with ID '${task_id}' not found.`;
				}
				return JSON.stringify(updated);
			}

			if (action === "get") {
				const task_id = args.task_id as string | undefined;
				if (!task_id) {
					return "Error: 'task_id' is required for the 'get' action.";
				}
				const task = taskList.getTask(task_id);
				if (!task) {
					return `Error: Task with ID '${task_id}' not found.`;
				}
				return JSON.stringify(task);
			}

			if (action === "list") {
				const tasks = taskList.getTasks();
				if (tasks.length === 0) {
					return "No tasks.";
				}
				return JSON.stringify(tasks);
			}

			if (action === "remove") {
				const task_id = args.task_id as string | undefined;
				if (!task_id) {
					return "Error: 'task_id' is required for the 'remove' action.";
				}
				const removed = taskList.removeTask(task_id);
				if (!removed) {
					return `Error: Task with ID '${task_id}' not found.`;
				}
				return `Task '${task_id}' removed successfully.`;
			}

			return `Error: Unknown action '${action}'.`;
		},
	};
}
