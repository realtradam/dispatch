import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExecBackend } from "@dispatch/exec-backend";
import { createLogger, type ToolExecuteContext } from "@dispatch/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWriteFileTool, decideOverwrite, validateArgs } from "./write-file.js";

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

/**
 * Build a write_file tool wired to the real local ExecBackend (node:fs,
 * behavior-identical to today's inline calls). No `@dispatch/*` mocking — the
 * real fs edge is exercised, matching the constitution's strict-core rule.
 */
function makeTool(workdir: string) {
	return createWriteFileTool({ resolveBackend: () => localExecBackend, workdir });
}

let workdir: string;

beforeEach(async () => {
	workdir = await mkdtemp(join(tmpdir(), "tool-write-file-test-"));
});

afterEach(async () => {
	await rm(workdir, { recursive: true, force: true });
});

describe("decideOverwrite", () => {
	it("returns create when file absent and overwrite is false", () => {
		expect(decideOverwrite(false, false)).toBe("create");
	});

	it("returns create when file absent and overwrite is false (default)", () => {
		expect(decideOverwrite(false, false)).toBe("create");
	});

	it("returns error when file exists and overwrite is false", () => {
		const result = decideOverwrite(true, false);
		expect(typeof result).toBe("object");
		if (typeof result === "object") {
			expect(result.error).toContain("already exists");
		}
	});

	it("returns overwrite when file exists and overwrite is true", () => {
		expect(decideOverwrite(true, true)).toBe("overwrite");
	});

	it("returns error when file absent and overwrite is true", () => {
		const result = decideOverwrite(false, true);
		expect(typeof result).toBe("object");
		if (typeof result === "object") {
			expect(result.error).toContain("does not exist");
		}
	});

	it("covers all four rows of the truth table", () => {
		expect(decideOverwrite(false, false)).toBe("create");
		expect(decideOverwrite(true, false)).toEqual(
			expect.objectContaining({ error: expect.any(String) }),
		);
		expect(decideOverwrite(true, true)).toBe("overwrite");
		expect(decideOverwrite(false, true)).toEqual(
			expect.objectContaining({ error: expect.any(String) }),
		);
	});
});

describe("validateArgs", () => {
	it("returns validated args for valid input", () => {
		const result = validateArgs({ path: "foo.txt", content: "hello" });
		expect(result).toEqual({ path: "foo.txt", content: "hello", overwrite: false });
	});

	it("parses overwrite as true", () => {
		const result = validateArgs({ path: "foo.txt", content: "x", overwrite: true });
		expect(result).toEqual({ path: "foo.txt", content: "x", overwrite: true });
	});

	it("defaults overwrite to false", () => {
		const result = validateArgs({ path: "foo.txt", content: "x" });
		expect(result).toEqual({ path: "foo.txt", content: "x", overwrite: false });
	});

	it("accepts empty string content", () => {
		const result = validateArgs({ path: "foo.txt", content: "" });
		expect(result).toEqual({ path: "foo.txt", content: "", overwrite: false });
	});

	it("returns error for null args", () => {
		expect(validateArgs(null)).toHaveProperty("error");
	});

	it("returns error for missing path", () => {
		expect(validateArgs({ content: "x" })).toHaveProperty("error");
	});

	it("returns error for missing content", () => {
		expect(validateArgs({ path: "foo.txt" })).toHaveProperty("error");
	});

	it("returns error for non-string content", () => {
		expect(validateArgs({ path: "foo.txt", content: 123 })).toHaveProperty("error");
	});

	it("returns error for non-boolean overwrite", () => {
		expect(validateArgs({ path: "foo.txt", content: "x", overwrite: "yes" })).toHaveProperty(
			"error",
		);
	});
});

describe("createWriteFileTool", () => {
	it("creates a new file when overwrite is unset and the file is absent", async () => {
		const tool = makeTool(workdir);
		const result = await tool.execute({ path: "new-file.txt", content: "hello world" }, stubCtx());

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("Created");
		const written = await readFile(join(workdir, "new-file.txt"), "utf8");
		expect(written).toBe("hello world");
	});

	it("errors when the file exists and overwrite is unset", async () => {
		await writeFile(join(workdir, "existing.txt"), "old content", "utf8");

		const tool = makeTool(workdir);
		const result = await tool.execute({ path: "existing.txt", content: "new content" }, stubCtx());

		expect(result.isError).toBe(true);
		expect(result.content).toContain("already exists");
		expect(result.content).toContain("overwrite");
		const unchanged = await readFile(join(workdir, "existing.txt"), "utf8");
		expect(unchanged).toBe("old content");
	});

	it("overwrites an existing file when overwrite is true", async () => {
		await writeFile(join(workdir, "existing.txt"), "old content", "utf8");

		const tool = makeTool(workdir);
		const result = await tool.execute(
			{ path: "existing.txt", content: "new content", overwrite: true },
			stubCtx(),
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("Overwrote");
		const written = await readFile(join(workdir, "existing.txt"), "utf8");
		expect(written).toBe("new content");
	});

	it("errors when overwrite is true but the file is absent", async () => {
		const tool = makeTool(workdir);
		const result = await tool.execute(
			{ path: "nonexistent.txt", content: "data", overwrite: true },
			stubCtx(),
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("does not exist");
	});

	it("errors when the parent directory does not exist", async () => {
		const tool = makeTool(workdir);
		const result = await tool.execute({ path: "no/such/dir/file.txt", content: "data" }, stubCtx());

		expect(result.isError).toBe(true);
		expect(result.content).toContain("Error");
	});

	it("concurrencySafe is false", () => {
		const tool = makeTool(workdir);
		expect(tool.concurrencySafe).toBe(false);
	});

	it("has correct name and parameters shape", () => {
		const tool = makeTool(workdir);
		expect(tool.name).toBe("write_file");
		expect(tool.parameters.type).toBe("object");
		expect(tool.parameters.required).toEqual(["path", "content"]);
		expect(tool.parameters.properties?.path?.type).toBe("string");
		expect(tool.parameters.properties?.content?.type).toBe("string");
		expect(tool.parameters.properties?.overwrite?.type).toBe("boolean");
	});

	it("never throws on bad input (always returns ToolResult)", async () => {
		const tool = makeTool(workdir);
		const inputs = [null, undefined, 42, "string", {}, { path: "" }, { path: 123 }];
		for (const input of inputs) {
			const result = await tool.execute(input, stubCtx());
			expect(result).toHaveProperty("content");
			expect(typeof result.content).toBe("string");
		}
	});

	it("respects ctx.cwd over baked workdir", async () => {
		const ctxDir = await mkdtemp(join(tmpdir(), "ctx-cwd-test-"));
		try {
			const tool = makeTool(workdir);
			const result = await tool.execute(
				{ path: "ctx-file.txt", content: "from ctx" },
				stubCtx({ cwd: ctxDir }),
			);

			expect(result.isError).toBeUndefined();
			const written = await readFile(join(ctxDir, "ctx-file.txt"), "utf8");
			expect(written).toBe("from ctx");
		} finally {
			await rm(ctxDir, { recursive: true, force: true });
		}
	});

	it("writes empty content", async () => {
		const tool = makeTool(workdir);
		const result = await tool.execute({ path: "empty.txt", content: "" }, stubCtx());

		expect(result.isError).toBeUndefined();
		const written = await readFile(join(workdir, "empty.txt"), "utf8");
		expect(written).toBe("");
	});

	it("writes content in subdirectory that exists", async () => {
		await mkdir(join(workdir, "sub"));
		const tool = makeTool(workdir);
		const result = await tool.execute({ path: "sub/file.txt", content: "nested" }, stubCtx());

		expect(result.isError).toBeUndefined();
		const written = await readFile(join(workdir, "sub", "file.txt"), "utf8");
		expect(written).toBe("nested");
	});
});
