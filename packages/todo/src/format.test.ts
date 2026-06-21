import { describe, expect, it } from "vitest";
import { formatTodoResult, type TodoItem } from "./pure.js";

describe("formatTodoResult", () => {
	it("formatTodoResult: returns JSON string of the todos", () => {
		const todos: TodoItem[] = [
			{ content: "alpha", status: "in_progress" },
			{ content: "beta", status: "pending" },
		];
		expect(formatTodoResult(todos)).toBe(JSON.stringify(todos, null, 2));
		// spot-check it is pretty-printed JSON (indented key)
		expect(formatTodoResult(todos)).toContain('"content": "alpha"');
	});

	it('formatTodoResult: empty array returns "[]"', () => {
		expect(formatTodoResult([])).toBe("[]");
	});
});
