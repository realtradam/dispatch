import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWriteFileTool } from "../../src/tools/write-file.js";

describe("write_file tool", () => {
	let workDir: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
	});

	afterEach(async () => {
		await rm(workDir, { recursive: true, force: true });
	});

	it("writes a new file", async () => {
		const tool = createWriteFileTool(workDir);
		const result = await tool.execute({
			path: "output.txt",
			content: "test content",
		});
		expect(result).toMatch(/successfully wrote/i);
		const written = await readFile(join(workDir, "output.txt"), "utf8");
		expect(written).toBe("test content");
	});

	it("creates parent directories", async () => {
		const tool = createWriteFileTool(workDir);
		const result = await tool.execute({
			path: "nested/dir/file.txt",
			content: "nested",
		});
		expect(result).toMatch(/successfully wrote/i);
		const written = await readFile(join(workDir, "nested/dir/file.txt"), "utf8");
		expect(written).toBe("nested");
	});

	it("blocks path traversal", async () => {
		const tool = createWriteFileTool(workDir);
		const result = await tool.execute({ path: "../evil.txt", content: "bad" });
		expect(result).toMatch(/outside the working directory/i);
	});
});
