import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	configToRuleset,
	getGlobalConfigPath,
	loadConfig,
	loadGlobalConfig,
	mergeConfigs,
} from "../../src/config/loader.js";
import { evaluate } from "../../src/permission/evaluate.js";
import type { DispatchConfig } from "../../src/types/index.js";

const TMP = join("/tmp/opencode", "dispatch-config-merge-test");
const LOCAL_DIR = join(TMP, "project");
const GLOBAL_PATH = join(TMP, "global", "dispatch.toml");

const prevGlobal = process.env.DISPATCH_GLOBAL_CONFIG;

beforeEach(() => {
	mkdirSync(LOCAL_DIR, { recursive: true });
	mkdirSync(join(TMP, "global"), { recursive: true });
	process.env.DISPATCH_GLOBAL_CONFIG = GLOBAL_PATH;
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	if (prevGlobal === undefined) delete process.env.DISPATCH_GLOBAL_CONFIG;
	else process.env.DISPATCH_GLOBAL_CONFIG = prevGlobal;
});

function writeGlobal(content: string): void {
	writeFileSync(GLOBAL_PATH, content, "utf-8");
}

function writeLocal(content: string): void {
	writeFileSync(join(LOCAL_DIR, "dispatch.toml"), content, "utf-8");
}

// ─── mergeConfigs (pure) ─────────────────────────────────────────

describe("mergeConfigs — lsp by id", () => {
	it("keeps non-conflicting servers from both global and local", () => {
		const global: DispatchConfig = {
			permissions: {},
			lsp: { biome: { command: ["biome"], extensions: [".ts"] } },
		};
		const local: DispatchConfig = {
			permissions: {},
			lsp: { luau: { command: ["luau-lsp"], extensions: [".luau"] } },
		};
		const merged = mergeConfigs(global, local);
		expect(Object.keys(merged.lsp ?? {}).sort()).toEqual(["biome", "luau"]);
	});

	it("local overrides global for the same server id", () => {
		const global: DispatchConfig = {
			permissions: {},
			lsp: { biome: { command: ["global-biome"], extensions: [".ts"] } },
		};
		const local: DispatchConfig = {
			permissions: {},
			lsp: { biome: { command: ["local-biome"], extensions: [".ts", ".tsx"] } },
		};
		const merged = mergeConfigs(global, local);
		expect(merged.lsp?.biome.command).toEqual(["local-biome"]);
		expect(merged.lsp?.biome.extensions).toEqual([".ts", ".tsx"]);
	});

	it("omits lsp entirely when neither side declares one", () => {
		const merged = mergeConfigs({ permissions: {} }, { permissions: {} });
		expect(merged.lsp).toBeUndefined();
	});

	it("does not mutate inputs", () => {
		const global: DispatchConfig = {
			permissions: {},
			lsp: { biome: { command: ["g"], extensions: [".ts"] } },
		};
		const local: DispatchConfig = {
			permissions: {},
			lsp: { biome: { command: ["l"], extensions: [".ts"] } },
		};
		mergeConfigs(global, local);
		expect(global.lsp?.biome.command).toEqual(["g"]);
		expect(local.lsp?.biome.command).toEqual(["l"]);
	});
});

describe("mergeConfigs — keys by id", () => {
	it("merges keys by id, local overriding global", () => {
		const global: DispatchConfig = {
			permissions: {},
			keys: [
				{ id: "a", provider: "x", base_url: "g-a" },
				{ id: "b", provider: "x", base_url: "g-b" },
			],
		};
		const local: DispatchConfig = {
			permissions: {},
			keys: [
				{ id: "b", provider: "x", base_url: "l-b" },
				{ id: "c", provider: "x", base_url: "l-c" },
			],
		};
		const merged = mergeConfigs(global, local);
		const byId = Object.fromEntries((merged.keys ?? []).map((k) => [k.id, k.base_url]));
		expect(byId).toEqual({ a: "g-a", b: "l-b", c: "l-c" });
	});

	it("carries global keys through when local has none", () => {
		const global: DispatchConfig = {
			permissions: {},
			keys: [{ id: "a", provider: "x", base_url: "g-a" }],
		};
		const merged = mergeConfigs(global, { permissions: {} });
		expect(merged.keys).toEqual([{ id: "a", provider: "x", base_url: "g-a" }]);
	});
});

describe("mergeConfigs — permissions", () => {
	it("merges nested groups pattern-by-pattern with local winning", () => {
		const global: DispatchConfig = {
			permissions: { bash: { "git status": "allow", "*": "ask" } },
		};
		const local: DispatchConfig = {
			permissions: { bash: { "*": "allow" } },
		};
		const merged = mergeConfigs(global, local);
		const bash = merged.permissions.bash as Record<string, string>;
		expect(bash["git status"]).toBe("allow");
		expect(bash["*"]).toBe("allow"); // local override
	});

	it("local string value replaces a global nested group", () => {
		const global: DispatchConfig = {
			permissions: { read: { "src/**": "allow" } },
		};
		const local: DispatchConfig = { permissions: { read: "deny" } };
		const merged = mergeConfigs(global, local);
		expect(merged.permissions.read).toBe("deny");
	});

	it("keeps global-only permission groups", () => {
		const global: DispatchConfig = { permissions: { read: "allow" } };
		const local: DispatchConfig = { permissions: { edit: "ask" } };
		const merged = mergeConfigs(global, local);
		expect(merged.permissions.read).toBe("allow");
		expect(merged.permissions.edit).toBe("ask");
	});

	it("local wins at evaluation time (findLast ordering)", () => {
		const merged = mergeConfigs(
			{ permissions: { bash: { "*": "ask" } } },
			{ permissions: { bash: { "*": "allow" } } },
		);
		const ruleset = configToRuleset(merged);
		expect(evaluate("bash", "anything", ruleset).action).toBe("allow");
	});
});

// ─── loadConfig (filesystem integration) ─────────────────────────

describe("loadConfig — global + local integration", () => {
	it("returns global config when local dispatch.toml is missing", () => {
		writeGlobal(`[lsp.biome]\ncommand = ["biome"]\nextensions = [".ts"]\n`);
		const config = loadConfig(LOCAL_DIR);
		expect(config.lsp?.biome.command).toEqual(["biome"]);
	});

	it("returns local config when global is missing", () => {
		writeLocal(`[permissions]\nread = "allow"\n`);
		const config = loadConfig(LOCAL_DIR);
		expect(config.permissions.read).toBe("allow");
		expect(config.lsp).toBeUndefined();
	});

	it("merges global LSP servers with local ones (local wins on id)", () => {
		writeGlobal(
			`[lsp.biome]\ncommand = ["global-biome"]\nextensions = [".ts"]\n\n[lsp.luau]\ncommand = ["luau-lsp"]\nextensions = [".luau"]\n`,
		);
		writeLocal(`[lsp.biome]\ncommand = ["local-biome"]\nextensions = [".ts"]\n`);
		const config = loadConfig(LOCAL_DIR);
		expect(config.lsp?.biome.command).toEqual(["local-biome"]);
		expect(config.lsp?.luau.command).toEqual(["luau-lsp"]);
	});

	it("a malformed global config is ignored, local still loads", () => {
		writeGlobal("not valid toml [[[");
		writeLocal(`[permissions]\nread = "allow"\n`);
		const config = loadConfig(LOCAL_DIR);
		expect(config.permissions.read).toBe("allow");
	});
});

describe("loadGlobalConfig", () => {
	it("returns empty default when the global file is missing", () => {
		expect(loadGlobalConfig()).toEqual({ permissions: {} });
	});

	it("loads the file at getGlobalConfigPath()", () => {
		writeGlobal(`[permissions]\nedit = "deny"\n`);
		expect(getGlobalConfigPath()).toBe(GLOBAL_PATH);
		expect(loadGlobalConfig().permissions.edit).toBe("deny");
	});
});
