import { describe, expect, it } from "vitest";
import type { DirEntry, ExecBackend, ExecResult, SpawnParams, StatResult } from "./backend.js";

/**
 * ExecBackend type conformance — a fake backend satisfies the interface.
 * (Pure compile-time + runtime check; zero internal mocks.)
 */
describe("ExecBackend type conformance", () => {
	it("a minimal fake satisfies the ExecBackend interface", () => {
		const fake: ExecBackend = {
			spawn: async (_params: SpawnParams): Promise<ExecResult> => ({
				exitCode: 0,
				timedOut: false,
				aborted: false,
			}),
			readFile: async (_path: string): Promise<string> => "",
			writeFile: async (_path: string, _content: string): Promise<void> => {},
			stat: async (_path: string): Promise<StatResult> => ({ isFile: true, isDirectory: false }),
			readdir: async (_path: string): Promise<readonly DirEntry[]> => [],
			exists: async (_path: string): Promise<boolean> => true,
		};

		// Runtime sanity: every method is present and callable.
		expect(typeof fake.spawn).toBe("function");
		expect(typeof fake.readFile).toBe("function");
		expect(typeof fake.writeFile).toBe("function");
		expect(typeof fake.stat).toBe("function");
		expect(typeof fake.readdir).toBe("function");
		expect(typeof fake.exists).toBe("function");
	});

	it("ExecResult is { exitCode, timedOut, aborted }", () => {
		const result: ExecResult = { exitCode: null, timedOut: true, aborted: false };
		expect(result.exitCode).toBeNull();
		expect(result.timedOut).toBe(true);
		expect(result.aborted).toBe(false);
	});

	it("SpawnParams carries the shell-tool seam fields", () => {
		const params: SpawnParams = {
			command: "echo",
			cwd: "/tmp",
			signal: new AbortController().signal,
			timeout: 1000,
			onOutput: () => {},
		};
		expect(params.command).toBe("echo");
		expect(params.timeout).toBe(1000);
	});

	it("StatResult distinguishes file vs directory", () => {
		const fileStat: StatResult = { isFile: true, isDirectory: false };
		const dirStat: StatResult = { isFile: false, isDirectory: true };
		expect(fileStat.isFile && !fileStat.isDirectory).toBe(true);
		expect(!dirStat.isFile && dirStat.isDirectory).toBe(true);
	});

	it("DirEntry carries name + isDirectory", () => {
		const entry: DirEntry = { name: "sub", isDirectory: true };
		expect(entry.name).toBe("sub");
		expect(entry.isDirectory).toBe(true);
	});
});
