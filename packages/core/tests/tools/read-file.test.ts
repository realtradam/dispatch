import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadFileTool } from "../../src/tools/read-file.js";
import { SPILL_ROOT } from "../../src/tools/truncate.js";

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
		expect(result).toContain("Hello, world!");
		expect(result).toContain("[file: hello.txt — lines 1-1 of 1]");
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

	it("respects offset and limit", async () => {
		const tool = createReadFileTool(workDir);
		await writeFile(join(workDir, "multi.txt"), "line1\nline2\nline3\nline4\nline5");
		const result = await tool.execute({ path: "multi.txt", offset: 2, limit: 2 });
		expect(result).toContain("line2");
		expect(result).toContain("line3");
		expect(result).not.toContain("line1");
		expect(result).not.toContain("line4");
		expect(result).toContain("[file: multi.txt — lines 2-3 of 5]");
	});

	it("truncates long lines and points to read_file_slice", async () => {
		const tool = createReadFileTool(workDir);
		const longLine = "x".repeat(3000);
		await writeFile(join(workDir, "wide.txt"), longLine);
		const result = await tool.execute({ path: "wide.txt" });
		expect(result).toContain("[line 1 truncated, total 3,000 chars");
		expect(result).toContain("use read_file_slice");
	});

	// The universal truncator writes oversized tool output to
	// `${SPILL_ROOT}/<tabId>/<callId>.txt` and the truncation notice tells
	// the AI to read that absolute path back. A previous implementation
	// used `resolve(join(workingDirectory, filePath))` which silently
	// concatenated the absolute spill path *under* the workdir, producing
	// a non-existent path and ENOENT — breaking the entire spill-and-resume
	// flow. These tests guard that contract.
	describe("absolute path handling (spill-file regression)", () => {
		let spillSubdir: string;

		beforeEach(async () => {
			spillSubdir = join(SPILL_ROOT, `test-${Date.now()}-${randomBytes(4).toString("hex")}`);
			await mkdir(spillSubdir, { recursive: true });
		});

		afterEach(async () => {
			await rm(spillSubdir, { recursive: true, force: true });
		});

		it("reads a spill file via its absolute path", async () => {
			const tool = createReadFileTool(workDir);
			const spillFile = join(spillSubdir, "call-abc.txt");
			const payload = "spilled output line 1\nspilled output line 2";
			await writeFile(spillFile, payload);

			const result = await tool.execute({ path: spillFile });

			expect(result).toContain("spilled output line 1");
			expect(result).toContain("spilled output line 2");
			expect(result).not.toMatch(/not found/i);
			expect(result).not.toMatch(/outside the working directory/i);
		});

		it("still rejects absolute paths that are neither in the workdir nor the spill root", async () => {
			const tool = createReadFileTool(workDir);
			// Path check happens before file read, so /etc/hostname existing
			// (or not) is irrelevant — we just need an absolute path outside
			// both the workdir and SPILL_ROOT.
			const result = await tool.execute({ path: "/etc/hostname" });
			expect(result).toMatch(/outside the working directory/i);
		});
	});

	// Symlinks must resolve consistently across the agent permission gate
	// and the tool itself. The containment check operates on the canonical
	// path — so a symlink-in-workdir that points outside is treated as
	// "outside" and gated like any other external path. Lexical-only
	// checks would let these slip through silently.
	describe("symlink handling", () => {
		let externalDir: string;

		beforeEach(async () => {
			externalDir = await mkdtemp(join(tmpdir(), "dispatch-external-"));
		});

		afterEach(async () => {
			await rm(externalDir, { recursive: true, force: true });
		});

		it("follows symlinks that stay inside the workdir", async () => {
			const tool = createReadFileTool(workDir);
			await writeFile(join(workDir, "real.txt"), "real content");
			await symlink(join(workDir, "real.txt"), join(workDir, "link.txt"));
			const result = await tool.execute({ path: "link.txt" });
			expect(result).toContain("real content");
			expect(result).not.toMatch(/outside the working directory/i);
		});

		it("blocks symlinks that escape the workdir", async () => {
			const tool = createReadFileTool(workDir);
			const secret = join(externalDir, "secret.txt");
			await writeFile(secret, "leaked secret");
			// Create a symlink *inside* workDir pointing to a file *outside*
			// workDir. Lexical-only path validation would see "workdir/trap.txt"
			// (under workdir) and allow it. Canonical resolution sees the
			// symlink's target and correctly rejects.
			await symlink(secret, join(workDir, "trap.txt"));
			const result = await tool.execute({ path: "trap.txt" });
			expect(result).toMatch(/outside the working directory/i);
			expect(result).not.toContain("leaked secret");
		});
	});
});
