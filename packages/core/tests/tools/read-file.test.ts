import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadFileTool } from "../../src/tools/read-file.js";

describe("read_file tool", () => {
	let workDir: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
	});

	afterEach(async () => {
		await rm(workDir, { recursive: true, force: true });
	});

	it("reads an existing file", async () => {
		const tool = createReadFileTool(workDir);
		await writeFile(join(workDir, "hello.txt"), "Hello, world!");
		const result = await tool.execute({ path: "hello.txt" });
		expect(result).toBe("Hello, world!");
	});

	it("returns error for non-existent file", async () => {
		const tool = createReadFileTool(workDir);
		const result = await tool.execute({ path: "missing.txt" });
		expect(result).toMatch(/not found/i);
	});

	it("blocks path traversal", async () => {
		const tool = createReadFileTool(workDir);
		const result = await tool.execute({ path: "../etc/passwd" });
		expect(result).toMatch(/outside the working directory/i);
	});
});
