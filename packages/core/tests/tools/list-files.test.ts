import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

	// Regression for `resolve(join(workingDirectory, relPath))` — when relPath
	// is absolute, `join` does NOT short-circuit. The old code silently
	// rewrote `/some/path` to `<workdir>/some/path` and either returned an
	// ENOENT-style error or, worse, listed an unrelated path. After the fix,
	// absolute paths resolve to themselves and the workdir gate behaves correctly.
	describe("absolute path handling", () => {
		it("lists an absolute path that lives under the workdir", async () => {
			const tool = createListFilesTool(workDir);
			await writeFile(join(workDir, "alpha.txt"), "a");
			await writeFile(join(workDir, "beta.txt"), "b");
			const result = await tool.execute({ path: workDir });
			expect(result).toContain("alpha.txt");
			expect(result).toContain("beta.txt");
			// "Error listing files" would indicate the path was mangled into a
			// non-existent location.
			expect(result).not.toMatch(/error listing/i);
		});

		it("rejects absolute paths outside the workdir with the workdir error (not a generic ENOENT)", async () => {
			const tool = createListFilesTool(workDir);
			// Use a tmpdir path that's definitely not under workDir. Under the
			// bug, this got rewritten to `<workdir>/tmp/...` and produced an
			// `Error listing files` ENOENT message instead of the workdir error.
			const evilPath = join(tmpdir(), `dispatch-evil-${Date.now()}`);
			const result = await tool.execute({ path: evilPath });
			expect(result).toMatch(/outside the working directory/i);
		});
	});

	// A directory symlink inside the workdir pointing to an external
	// directory is the classic escape vector for a `ls` style tool.
	// `canonicalize` must resolve the symlink so the listing is denied.
	describe("symlink handling", () => {
		let externalDir: string;

		beforeEach(async () => {
			externalDir = await mkdtemp(join(tmpdir(), "dispatch-external-"));
			await writeFile(join(externalDir, "secret.txt"), "secret");
		});

		afterEach(async () => {
			await rm(externalDir, { recursive: true, force: true });
		});

		it("blocks listing through a symlinked directory that escapes the workdir", async () => {
			const tool = createListFilesTool(workDir);
			await symlink(externalDir, join(workDir, "peek"));
			const result = await tool.execute({ path: "peek" });
			expect(result).toMatch(/outside the working directory/i);
			expect(result).not.toContain("secret.txt");
		});
	});
});
