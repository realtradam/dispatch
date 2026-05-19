import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunShellTool } from "../../src/tools/run-shell.js";

describe("run_shell tool", () => {
	let workDir: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "dispatch-test-"));
	});

	afterEach(async () => {
		await rm(workDir, { recursive: true, force: true });
	});

	it("executes a simple echo command", async () => {
		const tool = createRunShellTool(workDir);
		const raw = await tool.execute({ command: "echo hello" });
		const result = JSON.parse(raw);
		expect(result.stdout.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
	});

	it("returns non-zero exit code on failure", async () => {
		const tool = createRunShellTool(workDir);
		const raw = await tool.execute({ command: "exit 42" });
		const result = JSON.parse(raw);
		expect(result.exitCode).toBe(42);
	});

	it("captures stderr", async () => {
		const tool = createRunShellTool(workDir);
		const raw = await tool.execute({ command: "echo errormsg >&2" });
		const result = JSON.parse(raw);
		expect(result.stderr.trim()).toBe("errormsg");
	});

	it("handles timeout", async () => {
		const tool = createRunShellTool(workDir);
		const raw = await tool.execute({ command: "sleep 10", timeout: 100 });
		const result = JSON.parse(raw);
		// Either times out (non-zero exit) or returns an error
		expect(result.exitCode !== 0 || result.error !== undefined).toBe(true);
	}, 5000);

	it("executes in the working directory", async () => {
		const tool = createRunShellTool(workDir);
		const raw = await tool.execute({ command: "pwd" });
		const result = JSON.parse(raw);
		// On macOS /tmp is symlinked; use includes check
		expect(result.stdout.trim()).toContain(workDir.replace(/^\/private/, ""));
	});

	it("calls onOutput callback with stdout chunks", async () => {
		const tool = createRunShellTool(workDir);
		const onOutput = vi.fn();
		const raw = await tool.execute({ command: "echo streaming" }, { onOutput });
		const result = JSON.parse(raw);
		expect(result.stdout.trim()).toBe("streaming");
		expect(onOutput).toHaveBeenCalledWith(expect.stringContaining("streaming"), "stdout");
	});

	it("calls onOutput callback with stderr chunks", async () => {
		const tool = createRunShellTool(workDir);
		const onOutput = vi.fn();
		await tool.execute({ command: "echo errdata >&2" }, { onOutput });
		expect(onOutput).toHaveBeenCalledWith(expect.stringContaining("errdata"), "stderr");
	});

	it("works without context (backward compatible)", async () => {
		const tool = createRunShellTool(workDir);
		const raw = await tool.execute({ command: "echo nocontext" });
		const result = JSON.parse(raw);
		expect(result.stdout.trim()).toBe("nocontext");
	});
});
