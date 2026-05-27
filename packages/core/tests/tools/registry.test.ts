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

/** A non-trivial tool that exercises nested objects, required fields, and enums. */
const complexTool: ToolDefinition = {
	name: "complex_tool",
	description: "A tool with nested parameters",
	parameters: z.object({
		command: z.string().describe("Shell command to run"),
		options: z.object({
			timeout: z.number().optional().describe("Timeout in milliseconds"),
			shell: z.enum(["bash", "sh", "zsh"]).describe("Shell to use"),
		}),
		flags: z.array(z.string()).optional().describe("Additional flags"),
	}),
	execute: async (_args) => "complex result",
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

	describe("getAISDKTools", () => {
		it("returns correct keys for all tools", () => {
			const registry = createToolRegistry([mockTool, anotherTool]);
			const aiTools = registry.getAISDKTools();
			expect(aiTools).toHaveProperty("mock_tool");
			expect(aiTools).toHaveProperty("another_tool");
		});

		it("AI SDK tools have description from ToolDefinition", () => {
			const registry = createToolRegistry([mockTool]);
			const aiTools = registry.getAISDKTools();
			expect(aiTools.mock_tool.description).toBe("A mock tool for testing");
		});

		it("AI SDK tools surface schema via inputSchema, not parameters", () => {
			const registry = createToolRegistry([mockTool]);
			const aiTools = registry.getAISDKTools();
			// v6 uses inputSchema; v4 used parameters — this verifies the migration
			expect(aiTools.mock_tool).toHaveProperty("inputSchema");
			expect(aiTools.mock_tool).not.toHaveProperty("parameters");
		});

		it("AI SDK tools have no execute callback so the SDK does not auto-run", () => {
			const registry = createToolRegistry([mockTool, anotherTool, complexTool]);
			const aiTools = registry.getAISDKTools();
			for (const [name, sdkTool] of Object.entries(aiTools)) {
				expect(
					(sdkTool as Record<string, unknown>).execute,
					`Tool "${name}" should not have an execute callback`,
				).toBeUndefined();
			}
		});

		it("inputSchema produces valid JSONSchema7 for a simple tool", () => {
			const registry = createToolRegistry([mockTool]);
			const aiTools = registry.getAISDKTools();
			const schema = aiTools.mock_tool.inputSchema;
			// jsonSchema() wraps the raw JSONSchema7; it should expose the schema
			// as a `jsonSchema` property on the Schema object
			expect(schema).toBeDefined();
			// The wrapped schema object should carry the JSON Schema definition
			const schemaObj = schema as { jsonSchema: Record<string, unknown> };
			expect(schemaObj.jsonSchema).toBeDefined();
			expect(schemaObj.jsonSchema.type).toBe("object");
			const props = schemaObj.jsonSchema.properties as Record<string, unknown>;
			expect(props).toHaveProperty("input");
		});

		it("inputSchema produces correct JSONSchema7 for a non-trivial nested tool", () => {
			const registry = createToolRegistry([complexTool]);
			const aiTools = registry.getAISDKTools();
			const schema = aiTools.complex_tool.inputSchema;
			expect(schema).toBeDefined();
			const schemaObj = schema as { jsonSchema: Record<string, unknown> };
			expect(schemaObj.jsonSchema.type).toBe("object");

			const props = schemaObj.jsonSchema.properties as Record<string, Record<string, unknown>>;

			// Top-level required field "command"
			expect(props).toHaveProperty("command");
			expect(props.command.type).toBe("string");

			// Nested object "options"
			expect(props).toHaveProperty("options");
			expect(props.options.type).toBe("object");
			const optProps = props.options.properties as Record<string, Record<string, unknown>>;
			expect(optProps).toHaveProperty("shell");
			expect(optProps.shell.enum).toEqual(["bash", "sh", "zsh"]);

			// Optional array "flags" present as a property
			expect(props).toHaveProperty("flags");
			expect(props.flags.type).toBe("array");

			// Required fields should include "command" and "options"
			const required = schemaObj.jsonSchema.required as string[];
			expect(required).toContain("command");
			expect(required).toContain("options");
		});

		it("getTool still returns the original ToolDefinition with execute", () => {
			const registry = createToolRegistry([mockTool]);
			const def = registry.getTool("mock_tool");
			expect(def).toBeDefined();
			expect(typeof def?.execute).toBe("function");
			expect(def?.name).toBe("mock_tool");
		});
	});
});
