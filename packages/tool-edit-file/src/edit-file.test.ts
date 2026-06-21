import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type ToolExecuteContext } from "@dispatch/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeReplacement, createEditFileTool, validateArgs } from "./edit-file.js";

function stubCtx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
	return {
		toolCallId: "test-call-1",
		onOutput: () => {},
		signal: AbortSignal.timeout(5000),
		log: createLogger(
			{ extensionId: "test" },
			{ emit: () => {} },
			{ now: () => 0, newId: () => "id" },
		),
		...overrides,
	};
}

let workdir: string;

beforeEach(async () => {
	workdir = await mkdtemp(join(tmpdir(), "tool-edit-file-test-"));
});

afterEach(async () => {
	await rm(workdir, { recursive: true, force: true });
});

describe("validateArgs", () => {
	it("returns validated args for valid input", () => {
		const result = validateArgs({ path: "f.txt", oldString: "a", newString: "b" });
		expect(result).toEqual({ path: "f.txt", oldString: "a", newString: "b", replaceAll: false });
	});

	it("parses replaceAll true", () => {
		const result = validateArgs({
			path: "f.txt",
			oldString: "a",
			newString: "b",
			replaceAll: true,
		});
		expect(result).toEqual({ path: "f.txt", oldString: "a", newString: "b", replaceAll: true });
	});

	it("defaults replaceAll to false when omitted", () => {
		const result = validateArgs({ path: "f.txt", oldString: "a", newString: "b" });
		expect(result).toHaveProperty("replaceAll", false);
	});

	it("returns error for null args", () => {
		const result = validateArgs(null);
		expect(result).toHaveProperty("error");
	});

	it("returns error for missing path", () => {
		const result = validateArgs({ oldString: "a", newString: "b" });
		expect(result).toHaveProperty("error");
	});

	it("returns error for missing oldString", () => {
		const result = validateArgs({ path: "f.txt", newString: "b" });
		expect(result).toHaveProperty("error");
	});

	it("returns error for missing newString", () => {
		const result = validateArgs({ path: "f.txt", oldString: "a" });
		expect(result).toHaveProperty("error");
	});

	it("returns error for non-string path", () => {
		const result = validateArgs({ path: 123, oldString: "a", newString: "b" });
		expect(result).toHaveProperty("error");
	});

	it("returns error for non-string oldString", () => {
		const result = validateArgs({ path: "f.txt", oldString: 123, newString: "b" });
		expect(result).toHaveProperty("error");
	});
});

describe("computeReplacement", () => {
	it("replaces a single occurrence", () => {
		const result = computeReplacement("hello world", "world", "there", false);
		expect(result).toEqual({ content: "hello there", count: 1 });
	});

	it("replaces all occurrences when replaceAll is true", () => {
		const result = computeReplacement("aaa", "a", "b", true);
		expect(result).toEqual({ content: "bbb", count: 3 });
	});

	it("returns identical error when newString equals oldString", () => {
		const result = computeReplacement("hello", "hello", "hello", false);
		expect(result).toEqual({ kind: "identical" });
	});

	it("returns notFound error when oldString is not in content", () => {
		const result = computeReplacement("hello", "xyz", "abc", false);
		expect(result).toEqual({ kind: "notFound" });
	});

	it("returns notUnique error when oldString occurs multiple times and replaceAll is false", () => {
		const result = computeReplacement("abc abc abc", "abc", "xyz", false);
		expect(result).toEqual({ kind: "notUnique", count: 3 });
	});

	it("replaces only the single match when unique", () => {
		const result = computeReplacement("foo bar baz", "bar", "qux", false);
		expect(result).toEqual({ content: "foo qux baz", count: 1 });
	});

	it("handles replaceAll with multiple occurrences", () => {
		const result = computeReplacement("one two one two", "two", "three", true);
		expect(result).toEqual({ content: "one three one three", count: 2 });
	});

	it("handles empty oldString as notFound (empty string not searched)", () => {
		// empty oldString would cause infinite loop in split, so we treat it as not-found
		const result = computeReplacement("hello", "", "x", false);
		expect(result).toEqual({ kind: "notFound" });
	});

	it("handles oldString at start of content", () => {
		const result = computeReplacement("hello world", "hello", "goodbye", false);
		expect(result).toEqual({ content: "goodbye world", count: 1 });
	});

	it("handles oldString at end of content", () => {
		const result = computeReplacement("hello world", "world", "there", false);
		expect(result).toEqual({ content: "hello there", count: 1 });
	});

	it("handles multiline oldString and newString", () => {
		const content = "line1\nold line\nline3";
		const result = computeReplacement(content, "old line", "new line", false);
		expect(result).toEqual({ content: "line1\nnew line\nline3", count: 1 });
	});
});

describe("createEditFileTool", () => {
	it("replaces a single occurrence", async () => {
		const filePath = join(workdir, "test.txt");
		await writeFile(filePath, "hello world\n", "utf8");

		const tool = createEditFileTool(workdir);
		const result = await tool.execute(
			{ path: "test.txt", oldString: "world", newString: "there" },
			stubCtx(),
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("Replaced 1 occurrence");

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("hello there\n");
	});

	it("replaces all occurrences when replaceAll is true", async () => {
		const filePath = join(workdir, "test.txt");
		await writeFile(filePath, "aaa\n", "utf8");

		const tool = createEditFileTool(workdir);
		const result = await tool.execute(
			{ path: "test.txt", oldString: "a", newString: "b", replaceAll: true },
			stubCtx(),
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("Replaced 3 occurrences");

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("bbb\n");
	});

	it("errors when oldString is not found", async () => {
		const filePath = join(workdir, "test.txt");
		await writeFile(filePath, "hello\n", "utf8");

		const tool = createEditFileTool(workdir);
		const result = await tool.execute(
			{ path: "test.txt", oldString: "xyz", newString: "abc" },
			stubCtx(),
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("oldString not found");
	});

	it("errors when oldString is non-unique and replaceAll is false", async () => {
		const filePath = join(workdir, "test.txt");
		await writeFile(filePath, "abc abc abc\n", "utf8");

		const tool = createEditFileTool(workdir);
		const result = await tool.execute(
			{ path: "test.txt", oldString: "abc", newString: "xyz" },
			stubCtx(),
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("Found 3 matches");
	});

	it("errors when newString equals oldString", async () => {
		const filePath = join(workdir, "test.txt");
		await writeFile(filePath, "hello\n", "utf8");

		const tool = createEditFileTool(workdir);
		const result = await tool.execute(
			{ path: "test.txt", oldString: "hello", newString: "hello" },
			stubCtx(),
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("newString must differ from oldString");
	});

	it("errors / not-found for a nonexistent file", async () => {
		const tool = createEditFileTool(workdir);
		const result = await tool.execute(
			{ path: "nonexistent.txt", oldString: "a", newString: "b" },
			stubCtx(),
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});

	it("reads file under ctx.cwd when set", async () => {
		const ctxDir = await mkdtemp(join(tmpdir(), "ctx-cwd-test-"));
		try {
			const filePath = join(ctxDir, "ctx-file.txt");
			await writeFile(filePath, "hello world", "utf8");

			const tool = createEditFileTool(workdir);
			const result = await tool.execute(
				{ path: "ctx-file.txt", oldString: "world", newString: "there" },
				stubCtx({ cwd: ctxDir }),
			);

			expect(result.isError).toBeUndefined();
			expect(result.content).toContain("Replaced 1 occurrence");

			const content = await readFile(filePath, "utf8");
			expect(content).toBe("hello there");
		} finally {
			await rm(ctxDir, { recursive: true, force: true });
		}
	});

	it("falls back to baked workdir when ctx.cwd is omitted", async () => {
		const filePath = join(workdir, "baked-file.txt");
		await writeFile(filePath, "hello world", "utf8");

		const tool = createEditFileTool(workdir);
		const ctx = stubCtx();
		expect(ctx.cwd).toBeUndefined();
		const result = await tool.execute(
			{ path: "baked-file.txt", oldString: "world", newString: "there" },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("Replaced 1 occurrence");
	});

	it("never throws on bad input (always returns ToolResult)", async () => {
		const tool = createEditFileTool(workdir);

		const inputs = [null, undefined, 42, "string", {}, { path: "" }, { path: 123 }];
		for (const input of inputs) {
			const result = await tool.execute(input, stubCtx());
			expect(result).toHaveProperty("content");
			expect(typeof result.content).toBe("string");
		}
	});

	it("concurrencySafe is false", () => {
		const tool = createEditFileTool(workdir);
		expect(tool.concurrencySafe).toBe(false);
	});

	it("has correct name and parameters shape", () => {
		const tool = createEditFileTool(workdir);
		expect(tool.name).toBe("edit_file");
		expect(tool.parameters.type).toBe("object");
		expect(tool.parameters.required).toEqual(["path", "oldString", "newString"]);
		expect(tool.parameters.properties?.path?.type).toBe("string");
		expect(tool.parameters.properties?.oldString?.type).toBe("string");
		expect(tool.parameters.properties?.newString?.type).toBe("string");
		expect(tool.parameters.properties?.replaceAll?.type).toBe("boolean");
	});
});
