import { describe, expect, it } from "vitest";
import { resolveServersFromConfig } from "../../src/lsp/server.js";

describe("lsp/server resolveServersFromConfig", () => {
	it("returns [] for undefined config", () => {
		expect(resolveServersFromConfig(undefined)).toEqual([]);
	});

	it("resolves a server entry with id + extensions", () => {
		const servers = resolveServersFromConfig({
			"luau-lsp": { command: ["luau-lsp", "lsp"], extensions: [".luau"] },
		});
		expect(servers).toHaveLength(1);
		expect(servers[0]?.id).toBe("luau-lsp");
		expect(servers[0]?.extensions).toEqual([".luau"]);
		expect(typeof servers[0]?.spawn).toBe("function");
	});

	it("skips disabled entries", () => {
		const servers = resolveServersFromConfig({
			"luau-lsp": { command: ["luau-lsp", "lsp"], extensions: [".luau"], disabled: true },
		});
		expect(servers).toEqual([]);
	});

	it("skips entries with empty command or extensions", () => {
		const servers = resolveServersFromConfig({
			noCommand: { command: [], extensions: [".luau"] },
			noExt: { command: ["x"], extensions: [] },
		});
		expect(servers).toEqual([]);
	});

	it("resolves multiple servers", () => {
		const servers = resolveServersFromConfig({
			a: { command: ["a"], extensions: [".luau"] },
			b: { command: ["b"], extensions: [".lua"] },
		});
		expect(servers.map((s) => s.id).sort()).toEqual(["a", "b"]);
	});
});
