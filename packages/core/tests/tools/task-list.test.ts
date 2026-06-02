import { describe, expect, it, vi } from "vitest";
import { createTaskListTool, TaskList } from "../../src/tools/task-list.js";
import type { TaskItem } from "../../src/types/index.js";

describe("TaskList (declarative store)", () => {
	it("starts empty", () => {
		const list = new TaskList();
		expect(list.getTasks()).toEqual([]);
	});

	it("setTasks replaces the whole list and assigns positional ids", () => {
		const list = new TaskList();
		const result = list.setTasks([
			{ content: "first", status: "in_progress" },
			{ content: "second", status: "pending" },
		]);
		expect(result).toEqual([
			{ id: "task-1", content: "first", status: "in_progress" },
			{ id: "task-2", content: "second", status: "pending" },
		]);
		expect(list.getTasks()).toEqual(result);
	});

	it("a second setTasks fully replaces the previous list (no append)", () => {
		const list = new TaskList();
		list.setTasks([
			{ content: "a", status: "completed" },
			{ content: "b", status: "completed" },
			{ content: "c", status: "pending" },
		]);
		const next = list.setTasks([{ content: "only", status: "in_progress" }]);
		expect(next).toEqual([{ id: "task-1", content: "only", status: "in_progress" }]);
		expect(list.getTasks()).toHaveLength(1);
	});

	it("preserves all four statuses", () => {
		const list = new TaskList();
		const result = list.setTasks([
			{ content: "p", status: "pending" },
			{ content: "i", status: "in_progress" },
			{ content: "c", status: "completed" },
			{ content: "x", status: "cancelled" },
		]);
		expect(result.map((t) => t.status)).toEqual([
			"pending",
			"in_progress",
			"completed",
			"cancelled",
		]);
	});

	it("defaults missing/invalid status to pending", () => {
		const list = new TaskList();
		const result = list.setTasks([
			{ content: "no status" },
			{ content: "bogus", status: "done" },
			{ content: "junk", status: 42 },
		]);
		expect(result.map((t) => t.status)).toEqual(["pending", "pending", "pending"]);
	});

	it("an empty array clears the list", () => {
		const list = new TaskList();
		list.setTasks([{ content: "x", status: "pending" }]);
		expect(list.setTasks([])).toEqual([]);
		expect(list.getTasks()).toEqual([]);
	});

	it("getTasks returns copies (no external mutation leaks in)", () => {
		const list = new TaskList();
		list.setTasks([{ content: "x", status: "pending" }]);
		const snapshot = list.getTasks();
		snapshot[0].content = "mutated";
		expect(list.getTasks()[0].content).toBe("x");
	});

	it("onChange fires on every setTasks with the new snapshot", () => {
		const list = new TaskList();
		const seen: TaskItem[][] = [];
		const unsubscribe = list.onChange((tasks) => seen.push(tasks));
		list.setTasks([{ content: "a", status: "pending" }]);
		list.setTasks([{ content: "b", status: "completed" }]);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toEqual([{ id: "task-1", content: "a", status: "pending" }]);
		expect(seen[1]).toEqual([{ id: "task-1", content: "b", status: "completed" }]);
		unsubscribe();
		list.setTasks([{ content: "c", status: "pending" }]);
		expect(seen).toHaveLength(2);
	});
});

describe("createTaskListTool", () => {
	it("exposes a single declarative `todos` parameter and the name `todo`", () => {
		const tool = createTaskListTool(new TaskList());
		expect(tool.name).toBe("todo");
		// One top-level param: the whole-list `todos` array.
		const shape = (tool.parameters as { shape: Record<string, unknown> }).shape;
		expect(Object.keys(shape)).toEqual(["todos"]);
	});

	it("execute updates the store and echoes the list WITHOUT ids", async () => {
		const list = new TaskList();
		const tool = createTaskListTool(list);
		const out = await tool.execute({
			todos: [
				{ content: "plan", status: "completed" },
				{ content: "build", status: "in_progress" },
			],
		});
		expect(JSON.parse(out)).toEqual([
			{ content: "plan", status: "completed" },
			{ content: "build", status: "in_progress" },
		]);
		// Store has ids; the echo does not.
		expect(list.getTasks()).toEqual([
			{ id: "task-1", content: "plan", status: "completed" },
			{ id: "task-2", content: "build", status: "in_progress" },
		]);
	});

	it("execute fires onChange so the UI broadcast is wired", async () => {
		const list = new TaskList();
		const cb = vi.fn();
		list.onChange(cb);
		const tool = createTaskListTool(list);
		await tool.execute({ todos: [{ content: "x", status: "pending" }] });
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("execute with an empty array clears the store", async () => {
		const list = new TaskList();
		list.setTasks([{ content: "x", status: "pending" }]);
		const tool = createTaskListTool(list);
		const out = await tool.execute({ todos: [] });
		expect(JSON.parse(out)).toEqual([]);
		expect(list.getTasks()).toEqual([]);
	});

	it("execute defaults invalid status to pending in both store and echo", async () => {
		const list = new TaskList();
		const tool = createTaskListTool(list);
		const out = await tool.execute({ todos: [{ content: "x", status: "done" }] });
		expect(JSON.parse(out)).toEqual([{ content: "x", status: "pending" }]);
		expect(list.getTasks()[0].status).toBe("pending");
	});

	it("execute rejects a non-array todos param", async () => {
		const tool = createTaskListTool(new TaskList());
		const out = await tool.execute({ todos: "nope" });
		expect(out).toMatch(/Error/);
	});

	it("execute rejects items missing a content string", async () => {
		const tool = createTaskListTool(new TaskList());
		const out = await tool.execute({ todos: [{ status: "pending" }] });
		expect(out).toMatch(/Error/);
	});
});
