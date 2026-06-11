import { describe, expect, it } from "vitest";
import type { LspManager } from "./manager.js";
import { createLspTool } from "./tool.js";

function stubManager(overrides?: Partial<LspManager>): LspManager {
	return {
		status: async () => [],
		getClient: () => undefined,
		shutdownAll: () => {},
		...overrides,
	} as unknown as LspManager;
}

describe("tool", () => {
	it("diagnostics formats errors", async () => {
		const tool = createLspTool(stubManager());
		const result = await tool.execute(
			{ operation: "diagnostics", path: "test.ts" },
			{
				toolCallId: "test",
				onOutput: () => {},
				signal: AbortSignal.timeout(5000),
				log: {
					debug: () => {},
					info: () => {},
					warn: () => {},
					error: () => {},
					child: () => ({}) as never,
					span: () => ({}) as never,
				},
				cwd: "/project",
			},
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("No language server configured");
	});

	it("position ops convert 1-based to 0-based", async () => {
		let receivedPosition: { line: number; character: number } | null = null;

		const mockClient = {
			getState: () => "connected" as const,
			getStateError: () => undefined,
			request: async (method: string, params: unknown) => {
				if (method === "textDocument/hover") {
					receivedPosition = (params as { position: { line: number; character: number } }).position;
					return { contents: { value: "hover result" } };
				}
				return null;
			},
			waitForDiagnostics: async () => "",
		};

		const tool = createLspTool(
			stubManager({
				status: async () => [
					{
						id: "ts",
						name: "TypeScript",
						root: "/project",
						extensions: [".ts"],
						state: "connected",
					},
				],
				getClient: () => mockClient as never,
			}),
		);

		const result = await tool.execute(
			{ operation: "hover", path: "test.ts", line: 5, character: 10 },
			{
				toolCallId: "test",
				onOutput: () => {},
				signal: AbortSignal.timeout(5000),
				log: {
					debug: () => {},
					info: () => {},
					warn: () => {},
					error: () => {},
					child: () => ({}) as never,
					span: () => ({}) as never,
				},
				cwd: "/project",
			},
		);

		expect(receivedPosition).toEqual({ line: 4, character: 9 });
		expect(result.content).toBe("hover result");
	});

	it("path resolved against ctx.cwd", async () => {
		let receivedUri: string | null = null;

		const mockClient = {
			getState: () => "connected" as const,
			getStateError: () => undefined,
			request: async (method: string, params: unknown) => {
				if (method === "textDocument/hover") {
					receivedUri = (params as { textDocument: { uri: string } }).textDocument.uri;
					return { contents: { value: "ok" } };
				}
				return null;
			},
			waitForDiagnostics: async () => "",
		};

		const tool = createLspTool(
			stubManager({
				status: async () => [
					{
						id: "ts",
						name: "TypeScript",
						root: "/project",
						extensions: [".ts"],
						state: "connected",
					},
				],
				getClient: () => mockClient as never,
			}),
		);

		await tool.execute(
			{ operation: "hover", path: "src/test.ts", line: 1, character: 1 },
			{
				toolCallId: "test",
				onOutput: () => {},
				signal: AbortSignal.timeout(5000),
				log: {
					debug: () => {},
					info: () => {},
					warn: () => {},
					error: () => {},
					child: () => ({}) as never,
					span: () => ({}) as never,
				},
				cwd: "/project",
			},
		);

		expect(receivedUri).toBe("file:///project/src/test.ts");
	});

	it("position op without line/character returns isError", async () => {
		const tool = createLspTool(
			stubManager({
				status: async () => [
					{
						id: "ts",
						name: "TypeScript",
						root: "/project",
						extensions: [".ts"],
						state: "connected",
					},
				],
			}),
		);

		const result = await tool.execute(
			{ operation: "hover", path: "test.ts" },
			{
				toolCallId: "test",
				onOutput: () => {},
				signal: AbortSignal.timeout(5000),
				log: {
					debug: () => {},
					info: () => {},
					warn: () => {},
					error: () => {},
					child: () => ({}) as never,
					span: () => ({}) as never,
				},
				cwd: "/project",
			},
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("requires both");
	});
});
