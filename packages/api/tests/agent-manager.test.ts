import type { AgentEvent, ToolDefinition } from "@dispatch/core";
import { describe, expect, it, vi } from "vitest";

// Mock @dispatch/core's Agent to avoid real LLM calls
vi.mock("@dispatch/core", () => ({
	Agent: class MockAgent {
		status = "idle";
		messages: unknown[] = [];
		async *run(_message: string) {
			yield { type: "status", status: "running" } as const;
			await new Promise<void>((r) => setTimeout(r, 10));
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
	createReadFileSliceTool(_wd: string): ToolDefinition {
		return {
			name: "read_file_slice",
			description: "read a char slice of a single line",
			parameters: { _type: "z.ZodObject", shape: {} } as unknown as ToolDefinition["parameters"],
			execute: async () => "mock slice",
		};
	},
	clearSpillForTab(_tabId: string) {},
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
		getModels() {
			return [];
		}
		getKeys() {
			return [];
		}
		getModelsByTag(_tag: string) {
			return [];
		}
		getAllTags() {
			return [];
		}
		hasAvailableKey(_provider: string) {
			return false;
		}
		allKeysExhausted() {
			return true;
		}
		markKeyExhausted() {}
		markKeyActive() {}
		updateConfig() {}
	},
	ModelResolver: class MockModelResolver {
		resolve(_tag: string) {
			return null;
		}
		waitForKey() {
			return Promise.resolve(null);
		}
	},
	TaskList: class MockTaskList {
		getTasks() {
			return [];
		}
		getTask() {
			return undefined;
		}
		addTask() {
			return { id: "task-1", title: "", description: "", status: "pending" };
		}
		updateTask() {
			return undefined;
		}
		removeTask() {
			return false;
		}
		onChange(_cb: unknown) {
			return () => {};
		}
	},
	createTaskListTool(_taskList: unknown) {
		return {
			name: "todo",
			description: "todo",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createSummonTool(_wd: string, _callbacks: unknown) {
		return {
			name: "summon",
			description: "summon",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createRetrieveTool(_callbacks: unknown) {
		return {
			name: "retrieve",
			description: "retrieve",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createTab() {},
	getClaudeAccountsFromDB() {
		return [];
	},
	refreshAccountCredentials() {
		return null;
	},
	refreshAccountCredentialsAsync() {
		return Promise.resolve(null);
	},
	resolveApiKey() {
		return null;
	},
	getSetting(_key: string) {
		return null;
	},
	appendMessage() {},
	BackgroundShellStore: class MockBackgroundShellStore {
		has() {
			return false;
		}
		getResult() {
			return Promise.resolve({ status: "error", error: "not found" });
		}
	},
	BackgroundTranscriptStore: class MockBackgroundTranscriptStore {
		has() {
			return false;
		}
		getResult() {
			return Promise.resolve({ status: "error", error: "not found" });
		}
	},
	createWebSearchTool() {
		return {
			name: "web_search",
			description: "web search",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
	createYoutubeTranscribeTool() {
		return {
			name: "youtube_transcribe",
			description: "youtube transcribe",
			parameters: { _type: "z.ZodObject", shape: {} },
			execute: async () => "mock",
		};
	},
}));

// Import after mock is defined (Vitest hoists vi.mock automatically)
const { AgentManager } = await import("../src/agent-manager.js");

describe("AgentManager", () => {
	it("initial status is idle", () => {
		const manager = new AgentManager();
		expect(manager.getStatus()).toBe("idle");
	});

	it("initial messageCount is 0", () => {
		const manager = new AgentManager();
		expect(manager.getMessageCount()).toBe(0);
	});

	it("event listeners receive events during processMessage", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => {
			events.push(event);
		});

		await manager.processMessage("tab-1", "test");

		expect(events.length).toBeGreaterThan(0);
		expect(events[0]).toMatchObject({ type: "status", status: "running" });

		const lastEvent = events[events.length - 1];
		expect(lastEvent).toMatchObject({ type: "status", status: "idle" });

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent).toBeDefined();
	});

	it("emits text-delta events during processMessage", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => {
			events.push(event);
		});

		await manager.processMessage("tab-1", "hello");

		const textDeltas = events.filter((e) => e.type === "text-delta");
		expect(textDeltas.length).toBeGreaterThan(0);
	});

	it("messageCount increments after processMessage", async () => {
		const manager = new AgentManager();
		await manager.processMessage("tab-1", "hello");
		expect(manager.getMessageCount()).toBe(1);
		await manager.processMessage("tab-1", "world");
		expect(manager.getMessageCount()).toBe(2);
	});

	it("status returns to idle after processMessage completes", async () => {
		const manager = new AgentManager();
		await manager.processMessage("tab-1", "test");
		expect(manager.getStatus()).toBe("idle");
	});

	it("unsubscribe removes listener", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		const unsubscribe = manager.onEvent((event) => {
			events.push(event);
		});

		unsubscribe();
		await manager.processMessage("tab-1", "test");

		expect(events.length).toBe(0);
	});

	it("multiple listeners all receive events", async () => {
		const manager = new AgentManager();
		const listener1 = vi.fn();
		const listener2 = vi.fn();

		manager.onEvent(listener1);
		manager.onEvent(listener2);

		await manager.processMessage("tab-1", "test");

		expect(listener1).toHaveBeenCalled();
		expect(listener2).toHaveBeenCalled();
	});
});
