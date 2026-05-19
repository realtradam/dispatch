import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolRegistry } from "../../src/tools/registry.js";
import type { ToolDefinition } from "../../src/types/index.js";

const mockTool: ToolDefinition = {
	name: "mock_tool",
	description: "A mock tool for testing",
	parameters: z.object({ input: z.string() }),
	execute: async (_args) => "mock result",
};

const anotherTool: ToolDefinition = {
	name: "another_tool",
	description: "Another mock tool",
	parameters: z.object({ value: z.number() }),
	execute: async (_args) => "another result",
};

describe("createToolRegistry", () => {
	it("returns all tools via getTools()", () => {
		const registry = createToolRegistry([mockTool, anotherTool]);
		const tools = registry.getTools();
		expect(tools).toHaveLength(2);
		expect(tools.map((t) => t.name)).toContain("mock_tool");
		expect(tools.map((t) => t.name)).toContain("another_tool");
	});

	it("retrieves specific tool by name", () => {
		const registry = createToolRegistry([mockTool, anotherTool]);
		const tool = registry.getTool("mock_tool");
		expect(tool).toBeDefined();
		expect(tool?.name).toBe("mock_tool");
	});

	it("returns undefined for unknown tool", () => {
		const registry = createToolRegistry([mockTool]);
		expect(registry.getTool("nonexistent")).toBeUndefined();
	});

	it("getAISDKTools returns correct format", () => {
		const registry = createToolRegistry([mockTool, anotherTool]);
		const aiTools = registry.getAISDKTools();
		expect(aiTools).toHaveProperty("mock_tool");
		expect(aiTools).toHaveProperty("another_tool");
		// Each should have description and parameters (AI SDK tool format)
		expect(aiTools.mock_tool).toHaveProperty("description");
		expect(aiTools.mock_tool).toHaveProperty("parameters");
	});
});
