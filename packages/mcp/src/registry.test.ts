import type { Logger } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { adaptTool, flattenContent, namespace } from "./registry.js";
import type { McpCallResult, McpContentItem, McpToolCaller, McpToolInfo } from "./types.js";

const mockSpan = {
	id: "span-1",
	log: {} as Logger,
	setAttributes: () => {},
	addLink: () => {},
	child: () => mockSpan,
	end: () => {},
};

const mockLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	child: () => mockLogger,
	span: () => mockSpan,
};

/**
 * A real, minimal McpToolCaller collaborator (not a mock of McpClient).
 * It records calls and returns a configurable result.
 */
function makeCaller(
	result: McpCallResult,
): McpToolCaller & { calls: Array<{ name: string; args: unknown }> } {
	const calls: Array<{ name: string; args: unknown }> = [];
	return {
		calls,
		callTool: async (name: string, args: unknown) => {
			calls.push({ name, args });
			return result;
		},
	};
}

describe("namespace", () => {
	it("produces <serverId>__<toolName>", () => {
		expect(namespace("freecad", "create_object")).toBe("freecad__create_object");
	});

	it("handles serverId with special chars", () => {
		expect(namespace("chrome-devtools", "navigate")).toBe("chrome-devtools__navigate");
	});

	it("handles empty toolName", () => {
		expect(namespace("server", "")).toBe("server__");
	});
});

describe("flattenContent", () => {
	it("flattens text content", () => {
		const content: McpContentItem[] = [{ type: "text", text: "hello world" }];
		expect(flattenContent(content)).toBe("hello world");
	});

	it("flattens image content", () => {
		const content: McpContentItem[] = [
			{ type: "image", data: "base64data", mimeType: "image/png" },
		];
		expect(flattenContent(content)).toBe("[image: image/png]");
	});

	it("flattens resource content with text", () => {
		const content: McpContentItem[] = [
			{ type: "resource", resource: { uri: "file:///test", text: "resource text" } },
		];
		expect(flattenContent(content)).toBe("resource text");
	});

	it("flattens resource content without text", () => {
		const content: McpContentItem[] = [{ type: "resource", resource: { uri: "file:///test" } }];
		expect(flattenContent(content)).toBe("[resource: file:///test]");
	});

	it("joins multiple items with newline", () => {
		const content: McpContentItem[] = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];
		expect(flattenContent(content)).toBe("first\nsecond");
	});

	it("returns empty string for empty content", () => {
		expect(flattenContent([])).toBe("");
	});

	it("handles mixed content types", () => {
		const content: McpContentItem[] = [
			{ type: "text", text: "here is an image:" },
			{ type: "image", data: "data", mimeType: "image/jpeg" },
			{ type: "resource", resource: { uri: "file:///x", text: "some data" } },
		];
		expect(flattenContent(content)).toBe("here is an image:\n[image: image/jpeg]\nsome data");
	});
});

describe("adaptTool", () => {
	it("maps inputSchema to ToolParameterSchema", () => {
		const mcpTool: McpToolInfo = {
			name: "create_obj",
			description: "Create an object",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string", description: "Object name" } },
				required: ["name"],
			},
		};
		const caller = makeCaller({ content: [] });
		const adapted = adaptTool("freecad", mcpTool, caller);

		expect(adapted.name).toBe("freecad__create_obj");
		expect(adapted.description).toBe("[freecad] Create an object");
		expect(adapted.parameters.type).toBe("object");
		expect(adapted.parameters.properties).toEqual({
			name: { type: "string", description: "Object name" },
		});
		expect(adapted.parameters.required).toEqual(["name"]);
		expect(adapted.concurrencySafe).toBe(false);
	});

	it("execute proxies to callTool", async () => {
		const mcpTool: McpToolInfo = {
			name: "test_tool",
			description: "Test",
			inputSchema: { type: "object" },
		};
		const caller = makeCaller({
			content: [{ type: "text", text: "called" }],
			isError: false,
		});
		const adapted = adaptTool("server", mcpTool, caller);

		const result = await adapted.execute(
			{ input: "value" },
			{
				toolCallId: "call-1",
				onOutput: () => {},
				signal: new AbortController().signal,
				log: mockLogger,
			},
		);

		expect(result.content).toBe("called");
		expect(result.isError).toBe(false);
		expect(caller.calls).toEqual([{ name: "test_tool", args: { input: "value" } }]);
	});

	it("execute propagates isError", async () => {
		const caller = makeCaller({
			content: [{ type: "text", text: "error occurred" }],
			isError: true,
		});

		const mcpTool: McpToolInfo = {
			name: "fail_tool",
			description: "Fails",
			inputSchema: { type: "object" },
		};
		const adapted = adaptTool("server", mcpTool, caller);

		const result = await adapted.execute(
			{},
			{
				toolCallId: "call-2",
				onOutput: () => {},
				signal: new AbortController().signal,
				log: mockLogger,
			},
		);

		expect(result.isError).toBe(true);
		expect(result.content).toBe("error occurred");
	});

	it("handles inputSchema without optional fields", () => {
		const mcpTool: McpToolInfo = {
			name: "simple",
			description: "Simple tool",
			inputSchema: { type: "object" },
		};
		const caller = makeCaller({ content: [] });
		const adapted = adaptTool("server", mcpTool, caller);

		expect(adapted.parameters.type).toBe("object");
		expect(adapted.parameters.properties).toBeUndefined();
		expect(adapted.parameters.required).toBeUndefined();
		expect(adapted.parameters.additionalProperties).toBeUndefined();
	});

	it("preserves additionalProperties", () => {
		const mcpTool: McpToolInfo = {
			name: "flex",
			description: "Flexible",
			inputSchema: {
				type: "object",
				additionalProperties: true,
			},
		};
		const caller = makeCaller({ content: [] });
		const adapted = adaptTool("server", mcpTool, caller);

		expect(adapted.parameters.additionalProperties).toBe(true);
	});

	it("execute flattens multi-item content", async () => {
		const caller = makeCaller({
			content: [
				{ type: "text", text: "summary" },
				{ type: "image", data: "d", mimeType: "image/png" },
			],
			isError: false,
		});
		const mcpTool: McpToolInfo = {
			name: "multi",
			description: "Multi",
			inputSchema: { type: "object" },
		};
		const adapted = adaptTool("srv", mcpTool, caller);

		const result = await adapted.execute(
			{},
			{
				toolCallId: "c",
				onOutput: () => {},
				signal: new AbortController().signal,
				log: mockLogger,
			},
		);

		expect(result.content).toBe("summary\n[image: image/png]");
	});
});
