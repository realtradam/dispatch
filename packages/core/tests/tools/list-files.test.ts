import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createListFilesTool } from "../../src/tools/list-files.js";

describe("list_files tool", () => {
	let workDir: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
	});

	afterEach(async () => {
		await rm(workDir, { recursive: true, force: true });
	});

	it("lists directory contents", async () => {
		const tool = createListFilesTool(workDir);
		await writeFile(join(workDir, "file1.txt"), "a");
		await writeFile(join(workDir, "file2.txt"), "b");
		await mkdir(join(workDir, "subdir"));
		const result = await tool.execute({ path: "." });
		expect(result).toContain("file1.txt");
		expect(result).toContain("file2.txt");
		expect(result).toContain("subdir/");
	});

	it("defaults to current directory when path is undefined", async () => {
		const tool = createListFilesTool(workDir);
		await writeFile(join(workDir, "hello.txt"), "hi");
		const result = await tool.execute({});
		expect(result).toContain("hello.txt");
	});

	it("blocks path traversal", async () => {
		const tool = createListFilesTool(workDir);
		const result = await tool.execute({ path: "../" });
		expect(result).toMatch(/outside the working directory/i);
	});
});
