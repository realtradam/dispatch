import { access, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
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

	// Regression for `resolve(join(workingDirectory, filePath))` — when filePath
	// is absolute, `join` does NOT short-circuit, it concatenates. The old code
	// silently rewrote `/etc/foo` to `<workdir>/etc/foo` and "succeeded" by
	// writing to the wrong location. After the fix, absolute paths resolve
	// to themselves and the workdir gate behaves correctly.
	describe("absolute path handling", () => {
		it("writes an absolute path that lives under the workdir to the expected location", async () => {
			const tool = createWriteFileTool(workDir);
			const absoluteTarget = join(workDir, "abs.txt");
			const result = await tool.execute({ path: absoluteTarget, content: "abs content" });
			expect(result).toMatch(/successfully wrote/i);
			// File must exist at exactly `absoluteTarget`, NOT at
			// `<workdir>/<workdir>/abs.txt` (the old mangled location).
			const written = await readFile(absoluteTarget, "utf8");
			expect(written).toBe("abs content");
		});

		it("rejects absolute paths outside the workdir instead of silently mangling them", async () => {
			const tool = createWriteFileTool(workDir);
			// Pick a path under tmpdir that's definitely not under workDir.
			// Under the bug, this got rewritten to `<workdir>/tmp/...` and the
			// write "succeeded" at the wrong location.
			const evilPath = join(tmpdir(), `dispatch-evil-${Date.now()}.txt`);
			const result = await tool.execute({ path: evilPath, content: "should not land" });
			expect(result).toMatch(/outside the working directory/i);
		});
	});

	// Symlink containment: even when the *leaf* doesn't exist yet (the
	// common case for write_file creating a new file), `canonicalize`
	// must walk up to the nearest existing ancestor and resolve symlinks
	// there. Otherwise, a directory symlink inside workdir pointing
	// outside lets a write escape the workspace.
	describe("symlink handling", () => {
		let externalDir: string;

		beforeEach(async () => {
			externalDir = await mkdtemp(join(tmpdir(), "dispatch-external-"));
		});

		afterEach(async () => {
			await rm(externalDir, { recursive: true, force: true });
		});

		it("blocks writes that escape through a parent symlink (leaf does not exist yet)", async () => {
			const tool = createWriteFileTool(workDir);
			// `escape` is a symlink *inside* workdir to a directory *outside*.
			await symlink(externalDir, join(workDir, "escape"));
			const result = await tool.execute({
				path: "escape/payload.txt",
				content: "malicious payload",
			});
			expect(result).toMatch(/outside the working directory/i);
			// And the file must NOT exist in externalDir.
			await expect(access(join(externalDir, "payload.txt"))).rejects.toThrow();
			// And externalDir should be empty (nothing leaked through).
			const entries = await readdir(externalDir);
			expect(entries).toEqual([]);
		});
	});
});
