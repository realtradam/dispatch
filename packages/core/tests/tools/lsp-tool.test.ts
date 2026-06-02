import { describe, expect, it, vi } from "vitest";
import type { LspManager } from "../../src/lsp/manager.js";
import type { ResolvedLspServer } from "../../src/lsp/server.js";
import { createLspTool, type LspToolContext } from "../../src/tools/lsp.js";

const SERVER: ResolvedLspServer = {
	id: "luau-lsp",
	extensions: [".luau"],
	spawn: () => ({ process: {} as never }),
};

function makeManager(overrides: Partial<LspManager> = {}): LspManager {
	return {
		hasServerForFile: vi.fn(() => true),
		touchFile: vi.fn(async () => {}),
		getDiagnostics: vi.fn(() => ({})),
		request: vi.fn(async () => []),
		getClients: vi.fn(async () => []),
		shutdownAll: vi.fn(async () => {}),
		...overrides,
	} as unknown as LspManager;
}

function ctx(manager: LspManager, servers = [SERVER]): () => LspToolContext {
	return () => ({ manager, workingDirectory: "/work", servers });
}

describe("createLspTool", () => {
	it("exposes the expected schema/name", () => {
		const tool = createLspTool(ctx(makeManager()));
		expect(tool.name).toBe("lsp");
		expect(tool.description).toMatch(/luau-lsp/i);
	});

	it("errors when no servers are configured", async () => {
		const tool = createLspTool(ctx(makeManager(), []));
		const out = await tool.execute({ operation: "diagnostics", path: "a.luau" });
		expect(out).toMatch(/no LSP servers are configured/i);
	});

	it("errors when no server matches the file", async () => {
		const manager = makeManager({ hasServerForFile: vi.fn(() => false) as never });
		const tool = createLspTool(ctx(manager));
		const out = await tool.execute({ operation: "diagnostics", path: "a.ts" });
		expect(out).toMatch(/no configured LSP server matches/i);
	});

	it("diagnostics: touches the file then reports errors", async () => {
		const touchFile = vi.fn(async () => {});
		const getDiagnostics = vi.fn(() => ({
			"/work/a.luau": [
				{
					range: { start: { line: 2, character: 1 }, end: { line: 2, character: 9 } },
					severity: 1,
					message: "bad type",
				},
			],
		}));
		const manager = makeManager({
			touchFile: touchFile as never,
			getDiagnostics: getDiagnostics as never,
		});
		const tool = createLspTool(ctx(manager));
		const out = await tool.execute({ operation: "diagnostics", path: "a.luau" });
		expect(touchFile).toHaveBeenCalledOnce();
		expect(out).toContain("ERROR [3:2] bad type");
	});

	it("diagnostics: reports clean when no errors", async () => {
		const tool = createLspTool(ctx(makeManager()));
		const out = await tool.execute({ operation: "diagnostics", path: "a.luau" });
		expect(out).toMatch(/No errors reported/i);
	});

	it("hover: requires line and character", async () => {
		const tool = createLspTool(ctx(makeManager()));
		const out = await tool.execute({ operation: "hover", path: "a.luau" });
		expect(out).toMatch(/requires both 'line' and 'character'/i);
	});

	it("hover: converts 1-based coords to 0-based on the wire", async () => {
		const request = vi.fn(async () => [{ contents: "hi" }]);
		const manager = makeManager({ request: request as never });
		const tool = createLspTool(ctx(manager));
		await tool.execute({ operation: "hover", path: "a.luau", line: 5, character: 3 });
		expect(request).toHaveBeenCalledOnce();
		const arg = request.mock.calls[0]?.[0] as { method: string; params: { position: unknown } };
		expect(arg.method).toBe("textDocument/hover");
		expect(arg.params.position).toEqual({ line: 4, character: 2 });
	});

	it("references: includes declaration context", async () => {
		const request = vi.fn(async () => []);
		const manager = makeManager({ request: request as never });
		const tool = createLspTool(ctx(manager));
		await tool.execute({ operation: "references", path: "a.luau", line: 1, character: 1 });
		const arg = request.mock.calls[0]?.[0] as { params: { context?: unknown } };
		expect(arg.params.context).toEqual({ includeDeclaration: true });
	});

	it("documentSymbol: does not require a position", async () => {
		const request = vi.fn(async () => [{ name: "foo" }]);
		const manager = makeManager({ request: request as never });
		const tool = createLspTool(ctx(manager));
		const out = await tool.execute({ operation: "documentSymbol", path: "a.luau" });
		const arg = request.mock.calls[0]?.[0] as { method: string };
		expect(arg.method).toBe("textDocument/documentSymbol");
		expect(out).toContain("foo");
	});
});
