import { describe, expect, it } from "vitest";
import { prefix } from "../../src/tools/bash-arity.js";

describe("BashArity.prefix", () => {
	it("returns arity-2 prefix for known command 'git'", () => {
		expect(prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"]);
	});

	it("returns arity-3 prefix for npm", () => {
		expect(prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"]);
	});

	it("returns arity-2 prefix for bun", () => {
		expect(prefix(["bun", "install", "--frozen-lockfile"])).toEqual(["bun", "install"]);
	});

	it("returns just the command for unknown command", () => {
		expect(prefix(["unknowncmd", "arg1", "arg2"])).toEqual(["unknowncmd"]);
	});

	it("returns empty array for empty tokens", () => {
		expect(prefix([])).toEqual([]);
	});

	it("handles single token for unknown command", () => {
		expect(prefix(["ls"])).toEqual(["ls"]);
	});

	it("handles git with fewer tokens than arity", () => {
		expect(prefix(["git"])).toEqual(["git"]);
	});

	it("handles case-insensitive matching", () => {
		expect(prefix(["GIT", "checkout", "main"])).toEqual(["GIT", "checkout"]);
	});
});
