import { describe, expect, it } from "vitest";
import { resolveServers } from "./config.js";

describe("config", () => {
	it("built-in typescript resolves when tsconfig.json exists", async () => {
		const servers = await resolveServers({
			cwd: "/project",
			dispatchLspJson: null,
			opencodeJson: null,
			exists: async (path) => path === "/project/tsconfig.json",
		});

		const ts = servers.find((s) => s.id === "typescript");
		expect(ts).toBeDefined();
		expect(ts?.command).toEqual(["typescript-language-server", "--stdio"]);
		expect(ts?.extensions).toContain(".ts");
		expect(ts?.rootMarkers).toContain("tsconfig.json");
	});

	it(".dispatch/lsp.json servers resolve", async () => {
		const config = JSON.stringify({
			servers: {
				mylsp: {
					command: ["my-lsp", "--stdio"],
					extensions: [".ml"],
					rootMarkers: ["Makefile"],
				},
			},
		});

		const servers = await resolveServers({
			cwd: "/project",
			dispatchLspJson: config,
			opencodeJson: null,
			exists: async () => false,
		});

		expect(servers).toHaveLength(1);
		expect(servers[0]?.id).toBe("mylsp");
		expect(servers[0]?.command).toEqual(["my-lsp", "--stdio"]);
	});

	it("opencode.json lsp is used only as fallback", async () => {
		const opencodeConfig = JSON.stringify({
			lsp: {
				fallback: {
					command: ["fallback-lsp"],
					extensions: [".fb"],
				},
			},
		});

		const servers = await resolveServers({
			cwd: "/project",
			dispatchLspJson: null,
			opencodeJson: opencodeConfig,
			exists: async () => false,
		});

		expect(servers).toHaveLength(1);
		expect(servers[0]?.id).toBe("fallback");
	});

	it(".dispatch/lsp.json wins over opencode.json", async () => {
		const dispatchConfig = JSON.stringify({
			servers: { primary: { command: ["primary-lsp"], extensions: [".p"] } },
		});
		const opencodeConfig = JSON.stringify({
			lsp: { fallback: { command: ["fallback-lsp"], extensions: [".f"] } },
		});

		const servers = await resolveServers({
			cwd: "/project",
			dispatchLspJson: dispatchConfig,
			opencodeJson: opencodeConfig,
			exists: async () => false,
		});

		expect(servers).toHaveLength(1);
		expect(servers[0]?.id).toBe("primary");
	});

	it("luau-lsp sourcemap.autogenerate yields a rojo --watch sidecar", async () => {
		const config = JSON.stringify({
			servers: {
				luau: {
					command: ["luau-lsp", "lsp"],
					extensions: [".luau"],
					initialization: {
						"luau-lsp": {
							sourcemap: {
								autogenerate: true,
								rojoProjectFile: "default.project.json",
							},
						},
					},
				},
			},
		});

		const servers = await resolveServers({
			cwd: "/project",
			dispatchLspJson: config,
			opencodeJson: null,
			exists: async () => false,
		});

		expect(servers).toHaveLength(1);
		expect(servers[0]?.sidecar).toBeDefined();
		expect(servers[0]?.sidecar?.command).toEqual([
			"rojo",
			"sourcemap",
			"default.project.json",
			"--watch",
			"-o",
			"sourcemap.json",
		]);
	});
});
