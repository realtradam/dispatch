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

		await manager.processMessage("test");

		expect(events.length).toBeGreaterThan(0);
		expect(events[0]).toEqual({ type: "status", status: "running" });

		const lastEvent = events[events.length - 1];
		expect(lastEvent).toEqual({ type: "status", status: "idle" });

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent).toBeDefined();
	});

	it("emits text-delta events during processMessage", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => {
			events.push(event);
		});

		await manager.processMessage("hello");

		const textDeltas = events.filter((e) => e.type === "text-delta");
		expect(textDeltas.length).toBeGreaterThan(0);
	});

	it("messageCount increments after processMessage", async () => {
		const manager = new AgentManager();
		await manager.processMessage("hello");
		expect(manager.getMessageCount()).toBe(1);
		await manager.processMessage("world");
		expect(manager.getMessageCount()).toBe(2);
	});

	it("status returns to idle after processMessage completes", async () => {
		const manager = new AgentManager();
		await manager.processMessage("test");
		expect(manager.getStatus()).toBe("idle");
	});

	it("unsubscribe removes listener", async () => {
		const manager = new AgentManager();
		const events: AgentEvent[] = [];
		const unsubscribe = manager.onEvent((event) => {
			events.push(event);
		});

		unsubscribe();
		await manager.processMessage("test");

		expect(events.length).toBe(0);
	});

	it("multiple listeners all receive events", async () => {
		const manager = new AgentManager();
		const listener1 = vi.fn();
		const listener2 = vi.fn();

		manager.onEvent(listener1);
		manager.onEvent(listener2);

		await manager.processMessage("test");

		expect(listener1).toHaveBeenCalled();
		expect(listener2).toHaveBeenCalled();
	});
});
