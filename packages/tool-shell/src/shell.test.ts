import { createLogger, type ToolExecuteContext } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
	buildResult,
	createRunShellTool,
	type SpawnShell,
	truncateOutput,
	validateArgs,
} from "./shell.js";

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

function fakeSpawn(result: {
	exitCode: number | null;
	timedOut: boolean;
	aborted?: boolean;
}): SpawnShell {
	return async () => ({ aborted: false, ...result });
}

describe("validateArgs", () => {
	it("returns validated args for valid input", () => {
		const result = validateArgs({ command: "echo hello" });
		expect(result).toEqual({ command: "echo hello", timeout: 120_000 });
	});

	it("parses custom timeout", () => {
		const result = validateArgs({ command: "echo hello", timeout: 5000 });
		expect(result).toEqual({ command: "echo hello", timeout: 5000 });
	});

	it("floors fractional timeout", () => {
		const result = validateArgs({ command: "echo hello", timeout: 5000.7 });
		expect(result).toEqual({ command: "echo hello", timeout: 5000 });
	});

	it("returns error for null args", () => {
		const result = validateArgs(null);
		expect(result).toHaveProperty("error");
	});

	it("returns error for non-object args", () => {
		const result = validateArgs("string");
		expect(result).toHaveProperty("error");
	});

	it("returns error for missing command", () => {
		const result = validateArgs({});
		expect(result).toHaveProperty("error");
	});

	it("rejects missing or empty command", () => {
		const empty = validateArgs({ command: "" });
		expect(empty).toHaveProperty("error");
		const whitespace = validateArgs({ command: "   " });
		expect(whitespace).toHaveProperty("error");
		const missing = validateArgs({ timeout: 5000 });
		expect(missing).toHaveProperty("error");
	});

	it("returns error for non-string command", () => {
		const result = validateArgs({ command: 123 });
		expect(result).toHaveProperty("error");
	});

	it("returns error for invalid timeout", () => {
		const negative = validateArgs({ command: "echo", timeout: -1 });
		expect(negative).toHaveProperty("error");
		const zero = validateArgs({ command: "echo", timeout: 0 });
		expect(zero).toHaveProperty("error");
		const nan = validateArgs({ command: "echo", timeout: Number.NaN });
		expect(nan).toHaveProperty("error");
	});
});

describe("truncateOutput", () => {
	it("returns output unchanged when under cap", () => {
		const output = "short output";
		expect(truncateOutput(output, 100)).toBe("short output");
	});

	it("returns output unchanged when exactly at cap", () => {
		const output = "exact";
		expect(truncateOutput(output, 5)).toBe("exact");
	});

	it("truncates output beyond the cap and appends a notice", () => {
		const output = "a".repeat(100);
		const result = truncateOutput(output, 50);
		expect(result).toContain("a".repeat(50));
		expect(result).toContain("[Output truncated: exceeded 50 characters]");
		expect(result.length).toBeLessThan(output.length + 100);
	});
});

describe("buildResult", () => {
	it("maps a zero exit code to a success result", () => {
		const result = buildResult({
			exitCode: 0,
			timedOut: false,
			aborted: false,
			output: "all good",
			cap: 50_000,
		});
		expect(result.content).toBe("all good");
		expect(result.isError).toBeUndefined();
	});

	it("maps a non-zero exit code to an isError result", () => {
		const result = buildResult({
			exitCode: 1,
			timedOut: false,
			aborted: false,
			output: "some error",
			cap: 50_000,
		});
		expect(result.content).toBe("some error");
		expect(result.isError).toBe(true);
	});

	it("reports a timeout as an isError result", () => {
		const result = buildResult({
			exitCode: null,
			timedOut: true,
			aborted: false,
			output: "partial",
			cap: 50_000,
		});
		expect(result.content).toContain("partial");
		expect(result.content).toContain("[Command timed out]");
		expect(result.isError).toBe(true);
	});

	it("reports abort as an isError result", () => {
		const result = buildResult({
			exitCode: null,
			timedOut: false,
			aborted: true,
			output: "interrupted",
			cap: 50_000,
		});
		expect(result.content).toBe("interrupted");
		expect(result.isError).toBe(true);
	});

	it("truncates output in result when over cap", () => {
		const output = "x".repeat(60_000);
		const result = buildResult({
			exitCode: 0,
			timedOut: false,
			aborted: false,
			output,
			cap: 50_000,
		});
		expect(result.content).toContain("[Output truncated");
		expect(result.content.length).toBeLessThan(60_000);
	});
});

describe("createRunShellTool", () => {
	it("has correct name and parameters shape", () => {
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: fakeSpawn({ exitCode: 0, timedOut: false }),
		});
		expect(tool.name).toBe("run_shell");
		expect(tool.parameters.type).toBe("object");
		expect(tool.parameters.required).toEqual(["command"]);
		expect(tool.parameters.properties?.command?.type).toBe("string");
		expect(tool.parameters.properties?.timeout?.type).toBe("number");
	});

	it("concurrencySafe is false", () => {
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: fakeSpawn({ exitCode: 0, timedOut: false }),
		});
		expect(tool.concurrencySafe).toBe(false);
	});

	it("rejects missing or empty command", async () => {
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: fakeSpawn({ exitCode: 0, timedOut: false }),
		});
		const result = await tool.execute({}, stubCtx());
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Missing or empty");
	});

	it("maps a zero exit code to a success result", async () => {
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: async (_params) => {
				_params.onOutput("hello\n", "stdout");
				return { exitCode: 0, timedOut: false, aborted: false };
			},
		});
		const result = await tool.execute({ command: "echo hello" }, stubCtx());
		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("hello");
	});

	it("maps a non-zero exit code to an isError result", async () => {
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: async (_params) => {
				_params.onOutput("error output\n", "stderr");
				return { exitCode: 1, timedOut: false, aborted: false };
			},
		});
		const result = await tool.execute({ command: "false" }, stubCtx());
		expect(result.isError).toBe(true);
		expect(result.content).toContain("error output");
	});

	it("reports a timeout as an isError result", async () => {
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: async (_params) => {
				_params.onOutput("partial\n", "stdout");
				return { exitCode: null, timedOut: true, aborted: false };
			},
		});
		const result = await tool.execute({ command: "sleep 999" }, stubCtx());
		expect(result.isError).toBe(true);
		expect(result.content).toContain("[Command timed out]");
	});

	it("truncates output beyond the cap and appends a notice", async () => {
		const cap = 100;
		const tool = createRunShellTool({
			workdir: "/tmp",
			outputCap: cap,
			spawn: async (_params) => {
				_params.onOutput("a".repeat(200), "stdout");
				return { exitCode: 0, timedOut: false, aborted: false };
			},
		});
		const result = await tool.execute({ command: "gen" }, stubCtx());
		expect(result.content).toContain("[Output truncated");
		expect(result.content.length).toBeLessThan(200);
	});

	it("streams output to ctx.onOutput", async () => {
		const chunks: Array<{ data: string; stream: "stdout" | "stderr" }> = [];
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: async (params) => {
				params.onOutput("line1\n", "stdout");
				params.onOutput("err1\n", "stderr");
				params.onOutput("line2\n", "stdout");
				return { exitCode: 0, timedOut: false, aborted: false };
			},
		});
		await tool.execute(
			{ command: "test" },
			stubCtx({
				onOutput: (data, stream) => chunks.push({ data, stream }),
			}),
		);
		expect(chunks).toEqual([
			{ data: "line1\n", stream: "stdout" },
			{ data: "err1\n", stream: "stderr" },
			{ data: "line2\n", stream: "stdout" },
		]);
	});

	it("uses ctx.cwd when present over baked workdir", async () => {
		let receivedCwd = "";
		const tool = createRunShellTool({
			workdir: "/baked",
			spawn: async (params) => {
				receivedCwd = params.cwd;
				return { exitCode: 0, timedOut: false, aborted: false };
			},
		});
		await tool.execute({ command: "pwd" }, stubCtx({ cwd: "/custom" }));
		expect(receivedCwd).toBe("/custom");
	});

	it("falls back to baked workdir when ctx.cwd is omitted", async () => {
		let receivedCwd = "";
		const tool = createRunShellTool({
			workdir: "/baked",
			spawn: async (params) => {
				receivedCwd = params.cwd;
				return { exitCode: 0, timedOut: false, aborted: false };
			},
		});
		await tool.execute({ command: "pwd" }, stubCtx());
		expect(receivedCwd).toBe("/baked");
	});

	it("returns error for spawn failure", async () => {
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: async () => {
				throw new Error("spawn failed");
			},
		});
		const result = await tool.execute({ command: "bad" }, stubCtx());
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Error spawning command");
	});

	it("reports abort as isError when signal fires before spawn completes", async () => {
		const controller = new AbortController();
		controller.abort();
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: async () => ({ exitCode: 0, timedOut: false, aborted: false }),
		});
		const result = await tool.execute({ command: "test" }, stubCtx({ signal: controller.signal }));
		expect(result.isError).toBe(true);
	});

	it("passes timeout to spawn", async () => {
		let receivedTimeout = 0;
		const tool = createRunShellTool({
			workdir: "/tmp",
			spawn: async (params) => {
				receivedTimeout = params.timeout;
				return { exitCode: 0, timedOut: false, aborted: false };
			},
		});
		await tool.execute({ command: "test", timeout: 5000 }, stubCtx());
		expect(receivedTimeout).toBe(5000);
	});
});

describe("createRunShellTool (integration)", () => {
	it("runs a real echo command and captures stdout + cwd", async () => {
		const { realSpawn } = await import("./spawn.js");
		const tool = createRunShellTool({ workdir: "/tmp", spawn: realSpawn });
		let streamed = "";
		const result = await tool.execute(
			{ command: "echo hello-from-shell" },
			stubCtx({
				onOutput: (data) => {
					streamed += data;
				},
			}),
		);
		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("hello-from-shell");
		expect(streamed).toContain("hello-from-shell");
	});
});

describe("realSpawn — process-group kill on abort/timeout", () => {
	it("aborts a command with a grandchild holding the pipes and resolves immediately", async () => {
		const { realSpawn } = await import("./spawn.js");
		const controller = new AbortController();

		// "sleep 30 & wait" spawns a grandchild (sleep) that inherits the stdio
		// pipes. Killing just the sh parent does NOT close the pipes → close never
		// fires. With detached:true + process-group kill, the grandchild dies too.
		const promise = realSpawn({
			command: "sleep 30 & wait",
			cwd: "/tmp",
			signal: controller.signal,
			timeout: 60_000,
			onOutput: () => {},
		});

		// Give the shell time to actually spawn the grandchild.
		await new Promise((r) => setTimeout(r, 500));

		controller.abort();

		// Must resolve promptly (not wait 30s for the grandchild's sleep).
		const result = await promise;
		expect(result.aborted).toBe(true);
		expect(result.timedOut).toBe(false);

		// Give the OS a moment to reap the killed processes.
		await new Promise((r) => setTimeout(r, 200));

		// The grandchild sleep process should be gone. Check via pgrep.
		const { execSync } = await import("node:child_process");
		let sleeping: string[];
		try {
			sleeping = execSync("pgrep -f 'sleep 30'", { encoding: "utf-8" }).trim().split("\n");
		} catch {
			// pgrep returns non-zero when no processes match → all gone.
			sleeping = [];
		}
		expect(sleeping.length).toBe(0);
	});

	it("times out a command with a grandchild holding the pipes and resolves promptly", async () => {
		const { realSpawn } = await import("./spawn.js");
		const controller = new AbortController();

		const promise = realSpawn({
			command: "sleep 30 & wait",
			cwd: "/tmp",
			signal: controller.signal,
			timeout: 500,
			onOutput: () => {},
		});

		// Must resolve within a short window (not 30s).
		const start = Date.now();
		const result = await promise;
		const elapsed = Date.now() - start;

		expect(result.timedOut).toBe(true);
		expect(result.aborted).toBe(false);
		// Should resolve shortly after the 500ms timeout, well under 30s.
		expect(elapsed).toBeLessThan(10_000);

		// Grandchild should be dead.
		await new Promise((r) => setTimeout(r, 200));
		const { execSync } = await import("node:child_process");
		let sleeping: string[];
		try {
			sleeping = execSync("pgrep -f 'sleep 30'", { encoding: "utf-8" }).trim().split("\n");
		} catch {
			sleeping = [];
		}
		expect(sleeping.length).toBe(0);
	});

	it("captures stdout on normal completion (regression guard)", async () => {
		const { realSpawn } = await import("./spawn.js");
		const controller = new AbortController();
		let output = "";

		const result = await realSpawn({
			command: "echo hi",
			cwd: "/tmp",
			signal: controller.signal,
			timeout: 5_000,
			onOutput: (data) => {
				output += data;
			},
		});

		expect(result.aborted).toBe(false);
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(output).toContain("hi");
	});

	it("aborts a simple single-process command and resolves with aborted: true", async () => {
		const { realSpawn } = await import("./spawn.js");
		const controller = new AbortController();

		const promise = realSpawn({
			command: "sleep 30",
			cwd: "/tmp",
			signal: controller.signal,
			timeout: 60_000,
			onOutput: () => {},
		});

		// Let the sleep actually start.
		await new Promise((r) => setTimeout(r, 300));

		controller.abort();

		const result = await promise;
		expect(result.aborted).toBe(true);
		expect(result.timedOut).toBe(false);

		// The sleep process should be gone.
		await new Promise((r) => setTimeout(r, 200));
		const { execSync } = await import("node:child_process");
		let sleeping: string[];
		try {
			sleeping = execSync("pgrep -f 'sleep 30'", { encoding: "utf-8" }).trim().split("\n");
		} catch {
			sleeping = [];
		}
		expect(sleeping.length).toBe(0);
	});
});
