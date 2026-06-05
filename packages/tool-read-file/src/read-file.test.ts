import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type ToolExecuteContext } from "@dispatch/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createReadFileTool,
	isPathWithinWorkdir,
	renderLines,
	sliceLines,
	validateArgs,
} from "./read-file.js";

function stubCtx(): ToolExecuteContext {
	return {
		toolCallId: "test-call-1",
		onOutput: () => {},
		signal: AbortSignal.timeout(5000),
		log: createLogger(
			{ extensionId: "test" },
			{ emit: () => {} },
			{ now: () => 0, newId: () => "id" },
		),
	};
}

let workdir: string;

beforeEach(async () => {
	workdir = await mkdtemp(join(tmpdir(), "tool-read-file-test-"));
});

afterEach(async () => {
	await rm(workdir, { recursive: true, force: true });
});

describe("validateArgs", () => {
	it("returns validated args for valid input", () => {
		const result = validateArgs({ path: "foo.txt" });
		expect(result).toEqual({ path: "foo.txt", offset: 1, limit: 500 });
	});

	it("parses offset and limit", () => {
		const result = validateArgs({ path: "foo.txt", offset: 5, limit: 10 });
		expect(result).toEqual({ path: "foo.txt", offset: 5, limit: 10 });
	});

	it("clamps limit to hard cap of 5000", () => {
		const result = validateArgs({ path: "foo.txt", limit: 99999 });
		expect(result).toEqual({ path: "foo.txt", offset: 1, limit: 5000 });
	});

	it("returns error for null args", () => {
		const result = validateArgs(null);
		expect(result).toHaveProperty("error");
	});

	it("returns error for missing path", () => {
		const result = validateArgs({});
		expect(result).toHaveProperty("error");
	});

	it("returns error for non-string path", () => {
		const result = validateArgs({ path: 123 });
		expect(result).toHaveProperty("error");
	});

	it("returns error for invalid offset", () => {
		const result = validateArgs({ path: "foo.txt", offset: -1 });
		expect(result).toHaveProperty("error");
	});

	it("returns error for invalid limit", () => {
		const result = validateArgs({ path: "foo.txt", limit: 0 });
		expect(result).toHaveProperty("error");
	});
});

describe("sliceLines", () => {
	it("returns all lines with offset=1, limit=500", () => {
		const content = "line1\nline2\nline3";
		const result = sliceLines(content, 1, 500);
		expect(result.lines).toEqual(["line1", "line2", "line3"]);
		expect(result.totalLines).toBe(3);
	});

	it("slices with offset", () => {
		const content = "line1\nline2\nline3\nline4";
		const result = sliceLines(content, 2, 2);
		expect(result.lines).toEqual(["line2", "line3"]);
		expect(result.totalLines).toBe(4);
	});

	it("handles offset beyond content", () => {
		const content = "line1\nline2";
		const result = sliceLines(content, 10, 5);
		expect(result.lines).toEqual([]);
		expect(result.totalLines).toBe(2);
	});

	it("handles single line (no newline)", () => {
		const content = "only line";
		const result = sliceLines(content, 1, 10);
		expect(result.lines).toEqual(["only line"]);
		expect(result.totalLines).toBe(1);
	});
});

describe("isPathWithinWorkdir", () => {
	it("accepts a path within workdir", () => {
		expect(isPathWithinWorkdir("/tmp/workdir/file.txt", "/tmp/workdir")).toBe(true);
	});

	it("accepts the workdir itself", () => {
		expect(isPathWithinWorkdir("/tmp/workdir", "/tmp/workdir")).toBe(true);
	});

	it("rejects a path outside workdir", () => {
		expect(isPathWithinWorkdir("/tmp/other/file.txt", "/tmp/workdir")).toBe(false);
	});

	it("rejects a prefix attack (workdir prefix but different dir)", () => {
		expect(isPathWithinWorkdir("/tmp/workdir-evil/file.txt", "/tmp/workdir")).toBe(false);
	});
});

describe("renderLines", () => {
	it("renders lines with 1-indexed line numbers", () => {
		const result = renderLines(["a", "b", "c"], 1);
		expect(result).toBe("1: a\n2: b\n3: c");
	});

	it("renders with custom offset", () => {
		const result = renderLines(["x", "y"], 10);
		expect(result).toBe("10: x\n11: y");
	});
});

describe("createReadFileTool", () => {
	it("reads a real temp file", async () => {
		const filePath = join(workdir, "hello.txt");
		await writeFile(filePath, "hello\nworld\n", "utf8");

		const tool = createReadFileTool(workdir);
		const result = await tool.execute({ path: "hello.txt" }, stubCtx());

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("1: hello");
		expect(result.content).toContain("2: world");
	});

	it("respects offset and limit", async () => {
		const filePath = join(workdir, "lines.txt");
		await writeFile(filePath, "a\nb\nc\nd\ne\n", "utf8");

		const tool = createReadFileTool(workdir);
		const result = await tool.execute({ path: "lines.txt", offset: 2, limit: 2 }, stubCtx());

		expect(result.isError).toBeUndefined();
		expect(result.content).toBe("2: b\n3: c");
	});

	it("returns error for missing file", async () => {
		const tool = createReadFileTool(workdir);
		const result = await tool.execute({ path: "nonexistent.txt" }, stubCtx());

		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});

	it("returns error for path escape via ..", async () => {
		const tool = createReadFileTool(workdir);
		const result = await tool.execute({ path: "../escape.txt" }, stubCtx());

		expect(result.isError).toBe(true);
		expect(result.content).toContain("outside the working directory");
	});

	it("returns error for absolute path outside workdir", async () => {
		const tool = createReadFileTool(workdir);
		const result = await tool.execute({ path: "/etc/passwd" }, stubCtx());

		expect(result.isError).toBe(true);
		expect(result.content).toContain("outside the working directory");
	});

	it("returns empty-file content for empty file", async () => {
		const filePath = join(workdir, "empty.txt");
		await writeFile(filePath, "", "utf8");

		const tool = createReadFileTool(workdir);
		const result = await tool.execute({ path: "empty.txt" }, stubCtx());

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("empty file");
		expect(result.content).toContain("empty.txt");
	});

	it("returns error for offset beyond file length", async () => {
		const filePath = join(workdir, "short.txt");
		await writeFile(filePath, "one\n", "utf8");

		const tool = createReadFileTool(workdir);
		const result = await tool.execute({ path: "short.txt", offset: 100 }, stubCtx());

		expect(result.isError).toBe(true);
		expect(result.content).toContain("exceeds total lines");
	});

	it("never throws on bad input (always returns ToolResult)", async () => {
		const tool = createReadFileTool(workdir);

		const inputs = [null, undefined, 42, "string", {}, { path: "" }, { path: 123 }];
		for (const input of inputs) {
			const result = await tool.execute(input, stubCtx());
			expect(result).toHaveProperty("content");
			expect(typeof result.content).toBe("string");
		}
	});

	it("handles symlink escape attempt", async () => {
		// Create a symlink inside workdir pointing outside
		const outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
		const outsideFile = join(outsideDir, "secret.txt");
		await writeFile(outsideFile, "secret data", "utf8");

		const symlinkPath = join(workdir, "link.txt");
		const { symlink } = await import("node:fs/promises");
		await symlink(outsideFile, symlinkPath);

		const tool = createReadFileTool(workdir);
		const result = await tool.execute({ path: "link.txt" }, stubCtx());

		// The symlink resolves to outside workdir, so should be rejected
		expect(result.isError).toBe(true);
		expect(result.content).toContain("outside the working directory");

		await rm(outsideDir, { recursive: true, force: true });
	});

	it("concurrencySafe is true", () => {
		const tool = createReadFileTool(workdir);
		expect(tool.concurrencySafe).toBe(true);
	});

	it("has correct name and parameters shape", () => {
		const tool = createReadFileTool(workdir);
		expect(tool.name).toBe("read_file");
		expect(tool.parameters.type).toBe("object");
		expect(tool.parameters.required).toEqual(["path"]);
		expect(tool.parameters.properties?.path?.type).toBe("string");
	});
});
