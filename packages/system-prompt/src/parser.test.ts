import { describe, expect, it } from "vitest";
import { extractVariables, parseTemplate } from "./parser.js";

function vars(entries: ReadonlyArray<[string, string | null]>): Map<string, string | null> {
	return new Map(entries);
}

describe("parser", () => {
	describe("variable insertion", () => {
		it("simple variable insertion", () => {
			// 1. [system:time] with value → inserts it
			expect(parseTemplate("[system:time]", vars([["system:time", "12:00"]]))).toBe("12:00");
		});

		it("unknown variable → blank", () => {
			// 2. [unknown:foo] not in map → ""
			expect(parseTemplate("[unknown:foo]", vars([]))).toBe("");
		});

		it("null variable → blank", () => {
			// 3. [file:missing.md] with value null → ""
			expect(parseTemplate("[file:missing.md]", vars([["file:missing.md", null]]))).toBe("");
		});

		it("inserts value mid-text", () => {
			expect(parseTemplate("cwd is [prompt:cwd]!", vars([["prompt:cwd", "/proj"]]))).toBe(
				"cwd is /proj!",
			);
		});

		it("non-tag brackets stay literal", () => {
			expect(parseTemplate("[not a tag] done", vars([]))).toBe("[not a tag] done");
		});

		it("unclosed bracket stays literal", () => {
			expect(parseTemplate("[file:x", vars([]))).toBe("[file:x");
		});
	});

	describe("conditionals", () => {
		it("if block renders when variable exists", () => {
			// 4. [if file:AGENTS.md]YES[endif] with value → "YES"
			expect(
				parseTemplate("[if file:AGENTS.md]YES[endif]", vars([["file:AGENTS.md", "content"]])),
			).toBe("YES");
		});

		it("if block skipped when variable is null", () => {
			// 5. same with null → ""
			expect(parseTemplate("[if file:AGENTS.md]YES[endif]", vars([["file:AGENTS.md", null]]))).toBe(
				"",
			);
		});

		it("if block skipped when variable absent", () => {
			expect(parseTemplate("[if file:AGENTS.md]YES[endif]", vars([]))).toBe("");
		});

		it("if/else renders fallback when null", () => {
			// 6. [if file:X]A[else]B[endif] with null → "B"
			expect(parseTemplate("[if file:X]A[else]B[endif]", vars([["file:X", null]]))).toBe("B");
		});

		it("if/else renders then-branch when exists", () => {
			expect(parseTemplate("[if file:X]A[else]B[endif]", vars([["file:X", "v"]]))).toBe("A");
		});

		it("negated if renders when variable is null", () => {
			// 7. [if !file:X]A[endif] with null → "A"
			expect(parseTemplate("[if !file:X]A[endif]", vars([["file:X", null]]))).toBe("A");
		});

		it("negated if skipped when variable exists", () => {
			expect(parseTemplate("[if !file:X]A[endif]", vars([["file:X", "v"]]))).toBe("");
		});

		it("negated if renders when variable absent", () => {
			expect(parseTemplate("[if !file:X]A[endif]", vars([]))).toBe("A");
		});

		it("nested if — inner skipped when its var is null", () => {
			// 8. [if system:os][if file:X]A[endif][endif] with os=set, file=null → ""
			expect(
				parseTemplate(
					"[if system:os][if file:X]A[endif][endif]",
					vars([
						["system:os", "linux"],
						["file:X", null],
					]),
				),
			).toBe("");
		});

		it("nested if — inner renders when both exist", () => {
			expect(
				parseTemplate(
					"[if system:os][if file:X]A[endif][endif]",
					vars([
						["system:os", "linux"],
						["file:X", "v"],
					]),
				),
			).toBe("A");
		});

		it("nested if/else", () => {
			expect(
				parseTemplate(
					"[if system:os]os[if file:X]A[else]B[endif][endif]",
					vars([
						["system:os", "linux"],
						["file:X", null],
					]),
				),
			).toBe("osB");
		});

		it("unmatched if → literal text", () => {
			// 9. [if file:X]text (no endif) → "[if file:X]text"
			expect(parseTemplate("[if file:X]text", vars([["file:X", "v"]]))).toBe("[if file:X]text");
		});

		it("unmatched if with null var still emits literal tag", () => {
			expect(parseTemplate("[if file:X]text", vars([["file:X", null]]))).toBe("[if file:X]text");
		});

		it("stray endif → literal text", () => {
			expect(parseTemplate("a[endif]b", vars([]))).toBe("a[endif]b");
		});

		it("stray else → literal text", () => {
			expect(parseTemplate("a[else]b", vars([]))).toBe("a[else]b");
		});

		it("multi-line content renders correctly", () => {
			// 10. if block spanning multiple lines
			const template = "[if file:AGENTS.md]line1\nline2\nline3[endif]";
			expect(parseTemplate(template, vars([["file:AGENTS.md", "c"]]))).toBe("line1\nline2\nline3");
		});

		it("multi-line if/else block", () => {
			const template = "[if file:X]\nA\n[else]\nB\n[endif]";
			expect(parseTemplate(template, vars([["file:X", null]]))).toBe("\nB\n");
		});

		it("default-template-like structure renders", () => {
			const template =
				"You are a helpful coding assistant.\n\n[if file:AGENTS.md]\n[file:AGENTS.md]\n[endif]\n\nThe current working directory is [prompt:cwd].\n";
			expect(
				parseTemplate(
					template,
					vars([
						["file:AGENTS.md", "RULES"],
						["prompt:cwd", "/proj"],
					]),
				),
			).toBe(
				"You are a helpful coding assistant.\n\n\nRULES\n\n\nThe current working directory is /proj.\n",
			);
		});

		it("default-template-like structure without AGENTS.md", () => {
			const template = "[if file:AGENTS.md]\n[file:AGENTS.md]\n[endif]\nThe cwd is [prompt:cwd].";
			expect(parseTemplate(template, vars([["prompt:cwd", "/proj"]]))).toBe("\nThe cwd is /proj.");
		});
	});

	describe("extractVariables", () => {
		it("collects insertion + condition keys", () => {
			const template = "[system:time] [if file:AGENTS.md][file:AGENTS.md][endif] [if !git:branch]";
			expect(extractVariables(template)).toEqual(["system:time", "file:AGENTS.md", "git:branch"]);
		});

		it("deduplicates keys", () => {
			expect(extractVariables("[file:X][if file:X][file:X]")).toEqual(["file:X"]);
		});

		it("returns empty for plain text", () => {
			expect(extractVariables("no variables here")).toEqual([]);
		});

		it("ignores unmatched tags", () => {
			expect(extractVariables("[if file:X]no endif")).toEqual(["file:X"]);
		});
	});
});
