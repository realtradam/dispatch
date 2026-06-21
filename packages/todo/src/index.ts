/**
 * @dispatch/todo — the per-conversation task list. Owns the list state + a
 * per-conversation `custom` surface; the model maintains the list via the
 * `todo_write` tool (full-list replace, opencode pattern). The list is
 * transient (in-memory, per-conversation); the surface is the ONLY way the
 * frontend reads todo state.
 */

export { extension, manifest } from "./extension.js";
export {
	buildTodoSpec,
	clearTodos,
	formatTodoResult,
	getTodos,
	setTodos,
	TODO_RENDERER_ID,
	TODO_SURFACE_ID,
	type TodoItem,
	type TodoState,
	type TodoStatus,
	type ValidationResult,
	validateTodos,
} from "./pure.js";
export { createTodoWriteTool, type TodoWriteToolDeps } from "./tool.js";
