import { homedir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { configToRuleset, loadConfig } from "../../src/config/loader.js";

const TMP = join("/tmp/opencode", "dispatch-config-test");

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

function writeToml(content: string): void {
	writeFileSync(join(TMP, "dispatch.toml"), content, "utf-8");
}

describe("loadConfig", () => {
	it("returns empty permissions when dispatch.toml is missing", () => {
		const config = loadConfig(TMP);
		expect(config.permissions).toEqual({});
	});

	it("parses simple string permissions", () => {
		writeToml(`[permissions]\nread = "allow"\nedit = "deny"\n`);
		const config = loadConfig(TMP);
		expect(config.permissions["read"]).toBe("allow");
		expect(config.permissions["edit"]).toBe("deny");
	});

	it("parses nested pattern permissions", () => {
		writeToml(`[permissions.bash]\n"npm test" = "allow"\n"*" = "ask"\n`);
		const config = loadConfig(TMP);
		const bash = config.permissions["bash"] as Record<string, string>;
		expect(bash["npm test"]).toBe("allow");
		expect(bash["*"]).toBe("ask");
	});

	it("ignores comment lines", () => {
		writeToml(`# this is a comment\n[permissions]\n# another comment\nread = "allow"\n`);
		const config = loadConfig(TMP);
		expect(config.permissions["read"]).toBe("allow");
	});

	it("handles ~ expansion in nested keys", () => {
		writeToml(`[permissions.read]\n"~/projects/*" = "allow"\n`);
		const config = loadConfig(TMP);
		const read = config.permissions["read"] as Record<string, string>;
		expect(read["~/projects/*"]).toBe("allow");
	});

	it("handles $HOME expansion in nested keys", () => {
		writeToml(`[permissions.read]\n"$HOME/docs/*" = "allow"\n`);
		const config = loadConfig(TMP);
		const read = config.permissions["read"] as Record<string, string>;
		expect(read["$HOME/docs/*"]).toBe("allow");
	});

	it("parses quoted keys", () => {
		writeToml(`[permissions.bash]\n"git commit *" = "allow"\n"rm *" = "deny"\n`);
		const config = loadConfig(TMP);
		const bash = config.permissions["bash"] as Record<string, string>;
		expect(bash["git commit *"]).toBe("allow");
		expect(bash["rm *"]).toBe("deny");
	});

	it("handles multiple permission groups", () => {
		writeToml(
			`[permissions]\nread = "allow"\n\n[permissions.edit]\n"*" = "ask"\n"src/**" = "allow"\n\n[permissions.bash]\n"npm test" = "allow"\n"*" = "ask"\n`,
		);
		const config = loadConfig(TMP);
		expect(config.permissions["read"]).toBe("allow");
		const edit = config.permissions["edit"] as Record<string, string>;
		expect(edit["*"]).toBe("ask");
		expect(edit["src/**"]).toBe("allow");
		const bash = config.permissions["bash"] as Record<string, string>;
		expect(bash["npm test"]).toBe("allow");
		expect(bash["*"]).toBe("ask");
	});

	it("preserves # inside quoted string keys", () => {
		writeToml(`[permissions.bash]\n"file#1" = "allow"\n`);
		const config = loadConfig(TMP);
		const bash = config.permissions["bash"] as Record<string, string>;
		expect(bash["file#1"]).toBe("allow");
	});

	it("strips inline comments on table headers", () => {
		writeToml(`[permissions.bash] # scripts\n"*" = "allow"\n`);
		const config = loadConfig(TMP);
		const bash = config.permissions["bash"] as Record<string, string>;
		expect(bash["*"]).toBe("allow");
	});

	it("expands ~ with platform path separator", () => {
		// Simulate a path using the OS separator
		const pattern = `~${sep}projects${sep}*`;
		writeToml(`[permissions.read]\n"${pattern}" = "allow"\n`);
		const config = loadConfig(TMP);
		const read = config.permissions["read"] as Record<string, string>;
		expect(read[pattern]).toBe("allow");
	});

	it("throws on TOML parse errors", () => {
		writeToml("this is not valid TOML [[[");
		expect(() => loadConfig(TMP)).toThrow();
	});
});

describe("configToRuleset — new validations", () => {
	it("falls back to ask and warns for invalid action in string value", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const rules = configToRuleset({ permissions: { read: "allw" } });
		expect(rules[0]?.action).toBe("ask");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("allw"));
		warn.mockRestore();
	});

	it("falls back to ask and warns for invalid action in nested pattern", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const rules = configToRuleset({ permissions: { bash: { "*": "INVALID" } } });
		expect(rules[0]?.action).toBe("ask");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("INVALID"));
		warn.mockRestore();
	});

	it("expands ~ with backslash separator in patterns", () => {
		const home = homedir();
		// Force backslash path even on Linux to test the regex
		const rules = configToRuleset({ permissions: { read: { "~\\foo\\*": "allow" } } });
		expect(rules[0]?.pattern).toBe(`${home}\\foo\\*`);
	});
});

describe("configToRuleset", () => {
	it("produces a rule with pattern * for string value", () => {
		const rules = configToRuleset({ permissions: { read: "allow" } });
		expect(rules).toEqual([{ permission: "read", pattern: "*", action: "allow" }]);
	});

	it("produces rules for each pattern in an object value", () => {
		const rules = configToRuleset({
			permissions: { bash: { "npm test": "allow", "*": "ask" } },
		});
		expect(rules).toContainEqual({ permission: "bash", pattern: "npm test", action: "allow" });
		expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });
	});

	it("expands ~ in patterns", () => {
		const home = homedir();
		const rules = configToRuleset({ permissions: { read: { "~/foo/*": "allow" } } });
		expect(rules[0]?.pattern).toBe(`${home}/foo/*`);
	});

	it("expands $HOME in patterns", () => {
		const home = homedir();
		const rules = configToRuleset({ permissions: { read: { "$HOME/bar/*": "deny" } } });
		expect(rules[0]?.pattern).toBe(`${home}/bar/*`);
	});

	it("handles empty permissions", () => {
		const rules = configToRuleset({ permissions: {} });
		expect(rules).toEqual([]);
	});
});
