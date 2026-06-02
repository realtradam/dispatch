import { describe, expect, it } from "vitest";
import { validateConfig } from "../../src/config/schema.js";

describe("config schema — [lsp] block", () => {
	it("parses a valid custom server entry", () => {
		const { config, errors } = validateConfig({
			permissions: {},
			lsp: {
				"luau-lsp": {
					command: ["luau-lsp", "lsp"],
					extensions: [".luau"],
					initialization: { "luau-lsp": { platform: { type: "roblox" } } },
				},
			},
		});
		expect(errors).toHaveLength(0);
		expect(config.lsp).toBeDefined();
		const entry = config.lsp?.["luau-lsp"];
		expect(entry?.command).toEqual(["luau-lsp", "lsp"]);
		expect(entry?.extensions).toEqual([".luau"]);
		expect(entry?.initialization).toEqual({
			"luau-lsp": { platform: { type: "roblox" } },
		});
	});

	it("preserves env and nested initialization verbatim", () => {
		const { config } = validateConfig({
			permissions: {},
			lsp: {
				"luau-lsp": {
					command: ["luau-lsp", "lsp"],
					extensions: [".luau"],
					env: { PATH: "/custom/bin" },
					initialization: {
						"luau-lsp": {
							sourcemap: { enabled: true, autogenerate: true },
							diagnostics: { strictDatamodelTypes: false },
						},
					},
				},
			},
		});
		const entry = config.lsp?.["luau-lsp"];
		expect(entry?.env).toEqual({ PATH: "/custom/bin" });
		expect(entry?.initialization).toEqual({
			"luau-lsp": {
				sourcemap: { enabled: true, autogenerate: true },
				diagnostics: { strictDatamodelTypes: false },
			},
		});
	});

	it("rejects a custom server missing command", () => {
		const { config, errors } = validateConfig({
			permissions: {},
			lsp: { broken: { extensions: [".luau"] } },
		});
		expect(errors.some((e) => e.path === "lsp.broken.command")).toBe(true);
		expect(config.lsp).toBeUndefined();
	});

	it("rejects a custom server missing extensions", () => {
		const { errors } = validateConfig({
			permissions: {},
			lsp: { broken: { command: ["x"] } },
		});
		expect(errors.some((e) => e.path === "lsp.broken.extensions")).toBe(true);
	});

	it("rejects an empty command array", () => {
		const { errors } = validateConfig({
			permissions: {},
			lsp: { broken: { command: [], extensions: [".luau"] } },
		});
		expect(errors.some((e) => e.path === "lsp.broken.command")).toBe(true);
	});

	it("keeps a disabled entry without requiring command/extensions", () => {
		const { config, errors } = validateConfig({
			permissions: {},
			lsp: { "luau-lsp": { disabled: true } },
		});
		expect(errors).toHaveLength(0);
		expect(config.lsp?.["luau-lsp"]?.disabled).toBe(true);
	});

	it("skips a malformed entry but keeps valid siblings", () => {
		const { config, errors } = validateConfig({
			permissions: {},
			lsp: {
				good: { command: ["a"], extensions: [".luau"] },
				bad: { extensions: [".luau"] },
			},
		});
		expect(config.lsp?.good).toBeDefined();
		expect(config.lsp?.bad).toBeUndefined();
		expect(errors.length).toBeGreaterThan(0);
	});

	it("omits lsp entirely when not present", () => {
		const { config, errors } = validateConfig({ permissions: {} });
		expect(errors).toHaveLength(0);
		expect(config.lsp).toBeUndefined();
	});

	it("flags a non-object lsp value", () => {
		const { errors } = validateConfig({ permissions: {}, lsp: "nope" });
		expect(errors.some((e) => e.path === "lsp")).toBe(true);
	});
});
