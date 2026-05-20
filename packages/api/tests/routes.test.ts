import type { ToolDefinition } from "@dispatch/core";
import { describe, expect, it, vi } from "vitest";

// Mock @dispatch/core's Agent to avoid real LLM calls
vi.mock("@dispatch/core", () => ({
	Agent: class MockAgent {
		status = "idle";
		messages: unknown[] = [];
		async *run(_message: string) {
			yield { type: "status", status: "running" } as const;
			// Simulate some processing time so status stays "running"
			await new Promise<void>((r) => setTimeout(r, 100));
			yield { type: "text-delta", delta: "Hello " } as const;
			yield { type: "text-delta", delta: "world" } as const;
			yield {
				type: "done",
				message: { role: "assistant", content: "Hello world" },
			} as const;
			yield { type: "status", status: "idle" } as const;
		}
	},
	PermissionService: class MockPermissionService {
		ask(_request: unknown, _rulesets: unknown[]) {
			return Promise.resolve("once");
		}
		reply(_id: string, _reply: unknown) {}
		getPending() {
			return [];
		}
	},
	createReadFileTool(_wd: string): ToolDefinition {
		return {
			name: "read_file",
			description: "read a file",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => "mock file content",
		};
	},
	createWriteFileTool(_wd: string): ToolDefinition {
		return {
			name: "write_file",
			description: "write a file",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => true,
		};
	},
	createListFilesTool(_wd: string): ToolDefinition {
		return {
			name: "list_files",
			description: "list files",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => ["file1.ts"],
		};
	},
	createRunShellTool(_wd: string): ToolDefinition {
		return {
			name: "run_shell",
			description: "run shell command",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		};
	},
	loadConfig(_dir: string) {
		return { permissions: {} };
	},
	configToRuleset(_config: unknown) {
		return [];
	},
	validateConfig(_config: unknown) {
		return { config: _config, errors: [] };
	},
	createConfigWatcher(_dir: string, _onChange: unknown) {
		return { close() {} };
	},
	loadSkills(_dir: string) {
		return { skills: [], mappings: [] };
	},
	createSkillsWatcher(_dir: string, _onChange: unknown) {
		return { close() {} };
	},
	ModelRegistry: class MockModelRegistry {
		getModels() { return []; }
		getKeys() { return []; }
		getModelsByTag(_tag: string) { return []; }
		getAllTags() { return []; }
		hasAvailableKey(_provider: string) { return false; }
		allKeysExhausted() { return true; }
		markKeyExhausted() {}
		markKeyActive() {}
		updateConfig() {}
	},
	ModelResolver: class MockModelResolver {
		resolve(_tag: string) { return null; }
		waitForKey() { return Promise.resolve(null); }
	},
	TaskList: class MockTaskList {
		getTasks() { return []; }
		getTask() { return undefined; }
		addTask() { return { id: "task-1", title: "", description: "", status: "pending" }; }
		updateTask() { return undefined; }
		removeTask() { return false; }
		onChange(_cb: unknown) { return () => {}; }
	},
	createTaskListTool(_taskList: unknown) {
		return {
			name: "task_list",
			description: "task list",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
}));

const { app } = await import("../src/app.js");

describe("GET /health", () => {
	it("returns 200 with ok: true", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
	});
});

describe("GET /status", () => {
	it("returns idle status initially", async () => {
		const res = await app.request("/status");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("idle");
		expect(typeof body.messageCount).toBe("number");
	});
});

describe("POST /chat", () => {
	it("returns 200 with valid message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello world" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});

	it("returns 400 with empty message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 with whitespace-only message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "   " }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 with missing message field", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("returns 409 when agent is already running", async () => {
		// Start a message (non-blocking)
		await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "first message" }),
		});

		// Small delay to let the async generator start and emit "running" status
		await new Promise<void>((r) => setTimeout(r, 20));

		// Immediately send a second — agent should be running
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "second message" }),
		});
		expect(res.status).toBe(409);
	});
});
