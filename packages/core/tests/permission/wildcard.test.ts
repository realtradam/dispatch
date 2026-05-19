import { describe, expect, it } from "vitest";
import { Wildcard } from "../../src/permission/wildcard.js";

describe("Wildcard.match", () => {
	it("matches exact string", () => {
		expect(Wildcard.match("bash", "bash")).toBe(true);
		expect(Wildcard.match("bash", "read")).toBe(false);
	});

	it("matches * wildcard (any characters)", () => {
		expect(Wildcard.match("*", "bash")).toBe(true);
		expect(Wildcard.match("*", "anything")).toBe(true);
		expect(Wildcard.match("ba*", "bash")).toBe(true);
		expect(Wildcard.match("ba*", "ba")).toBe(true);
		expect(Wildcard.match("ba*", "read")).toBe(false);
	});

	it("matches ? wildcard (single character)", () => {
		expect(Wildcard.match("ba?h", "bash")).toBe(true);
		expect(Wildcard.match("ba?h", "bath")).toBe(true);
		expect(Wildcard.match("ba?h", "baXXh")).toBe(false);
		expect(Wildcard.match("?", "a")).toBe(true);
		expect(Wildcard.match("?", "ab")).toBe(false);
	});

	it("matches nested * patterns with path-like strings", () => {
		expect(Wildcard.match("/home/*", "/home/user")).toBe(true);
		expect(Wildcard.match("/home/*/file.txt", "/home/user/file.txt")).toBe(true);
		expect(Wildcard.match("/home/*/file.txt", "/home/user/subdir/file.txt")).toBe(true);
		expect(Wildcard.match("/home/*/file.txt", "/tmp/user/file.txt")).toBe(false);
	});

	it("escapes regex special characters in pattern", () => {
		expect(Wildcard.match("git add .", "git add .")).toBe(true);
		expect(Wildcard.match("git add .", "git add X")).toBe(false);
		expect(Wildcard.match("foo(bar)", "foo(bar)")).toBe(true);
		expect(Wildcard.match("foo(bar)", "fooXbar")).toBe(false);
	});

	it("is case-sensitive", () => {
		expect(Wildcard.match("Bash", "bash")).toBe(false);
		expect(Wildcard.match("BASH", "BASH")).toBe(true);
	});

	it("handles empty pattern and value", () => {
		expect(Wildcard.match("", "")).toBe(true);
		expect(Wildcard.match("", "x")).toBe(false);
		expect(Wildcard.match("*", "")).toBe(true);
	});
});
