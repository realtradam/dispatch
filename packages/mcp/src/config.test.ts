import { describe, expect, it } from "vitest";
import { resolveServers } from "./config.js";

describe("resolveServers", () => {
	it("resolves from .dispatch/mcp.json", () => {
		const dispatchConfig = JSON.stringify({
			servers: {
				freecad: { command: "uvx", args: ["freecad-mcp"], env: { KEY: "val" } },
			},
		});

		const result = resolveServers({ dispatchMcpJson: dispatchConfig, opencodeJson: null });

		expect(result.servers.length).toBe(1);
		expect(result.servers[0].id).toBe("freecad");
		expect(result.servers[0].command).toEqual(["uvx", "freecad-mcp"]);
		expect(result.servers[0].env).toEqual({ KEY: "val" });
		expect(result.servers[0].configSource).toBe(".dispatch/mcp.json");
		expect(result.shadowed).toBe(false);
	});

	it("falls back to opencode.json mcp key", () => {
		const opencodeConfig = JSON.stringify({
			mcp: {
				chrome: { command: "npx", args: ["chrome-devtools-mcp@latest"] },
			},
		});

		const result = resolveServers({ dispatchMcpJson: null, opencodeJson: opencodeConfig });

		expect(result.servers.length).toBe(1);
		expect(result.servers[0].id).toBe("chrome");
		expect(result.servers[0].command).toEqual(["npx", "chrome-devtools-mcp@latest"]);
		expect(result.servers[0].configSource).toBe("opencode.json");
		expect(result.shadowed).toBe(false);
	});

	it("shadow warning when both present", () => {
		const dispatchConfig = JSON.stringify({
			servers: {
				freecad: { command: "uvx", args: ["freecad-mcp"] },
			},
		});
		const opencodeConfig = JSON.stringify({
			mcp: {
				chrome: { command: "npx", args: ["chrome-devtools-mcp@latest"] },
			},
		});

		const result = resolveServers({
			dispatchMcpJson: dispatchConfig,
			opencodeJson: opencodeConfig,
		});

		expect(result.servers.length).toBe(1);
		expect(result.servers[0].id).toBe("freecad");
		expect(result.shadowed).toBe(true);
	});

	it("empty when neither present", () => {
		const result = resolveServers({ dispatchMcpJson: null, opencodeJson: null });

		expect(result.servers.length).toBe(0);
		expect(result.shadowed).toBe(false);
	});

	it("empty when dispatch has no servers key", () => {
		const result = resolveServers({
			dispatchMcpJson: JSON.stringify({}),
			opencodeJson: null,
		});

		expect(result.servers.length).toBe(0);
		expect(result.shadowed).toBe(false);
	});

	it("handles malformed JSON gracefully", () => {
		const result = resolveServers({
			dispatchMcpJson: "not valid json",
			opencodeJson: "{ also bad",
		});

		expect(result.servers.length).toBe(0);
		expect(result.shadowed).toBe(false);
	});

	it("server without args", () => {
		const dispatchConfig = JSON.stringify({
			servers: {
				simple: { command: "my-server" },
			},
		});

		const result = resolveServers({ dispatchMcpJson: dispatchConfig, opencodeJson: null });

		expect(result.servers.length).toBe(1);
		expect(result.servers[0].command).toEqual(["my-server"]);
	});

	it("multiple servers from dispatch", () => {
		const dispatchConfig = JSON.stringify({
			servers: {
				a: { command: "server-a" },
				b: { command: "server-b", args: ["--port", "3000"] },
			},
		});

		const result = resolveServers({ dispatchMcpJson: dispatchConfig, opencodeJson: null });

		expect(result.servers.length).toBe(2);
		const ids = result.servers.map((s) => s.id).sort();
		expect(ids).toEqual(["a", "b"]);
	});
});
