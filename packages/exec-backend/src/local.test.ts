import { writeFile as fsWriteFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecBackend } from "./backend.js";
import { createLocalExecBackend, localExecBackend } from "./local.js";

/**
 * LocalExecBackend — integration tests against the OUTERMOST real edge
 * (real fs/spawn). Zero internal mocks; no mocking of @dispatch/*.
 */
describe("LocalExecBackend", () => {
  const backend: ExecBackend = createLocalExecBackend();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "exec-backend-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("spawn", () => {
    it("runs a real `sh -c 'echo hi'` and returns exitCode 0 + captured stdout", async () => {
      let output = "";
      const result = await backend.spawn({
        command: "echo hi",
        cwd: tmpDir,
        signal: AbortSignal.timeout(5000),
        timeout: 5000,
        onOutput: (data) => {
          output += data;
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
      expect(output).toContain("hi");
    });

    it("returns a non-zero exit code for a failing command", async () => {
      const result = await backend.spawn({
        command: "false",
        cwd: tmpDir,
        signal: AbortSignal.timeout(5000),
        timeout: 5000,
        onOutput: () => {},
      });
      expect(result.exitCode).toBe(1);
      expect(result.aborted).toBe(false);
      expect(result.timedOut).toBe(false);
    });

    it("streams stderr separately from stdout", async () => {
      const streams: Array<{ data: string; stream: "stdout" | "stderr" }> = [];
      const result = await backend.spawn({
        command: "echo out; echo err 1>&2",
        cwd: tmpDir,
        signal: AbortSignal.timeout(5000),
        timeout: 5000,
        onOutput: (data, stream) => streams.push({ data, stream }),
      });
      expect(result.exitCode).toBe(0);
      expect(streams.some((s) => s.stream === "stdout" && s.data.includes("out"))).toBe(true);
      expect(streams.some((s) => s.stream === "stderr" && s.data.includes("err"))).toBe(true);
    });

    it("resolves with aborted: true when the signal fires", async () => {
      const controller = new AbortController();
      const promise = backend.spawn({
        command: "sleep 30",
        cwd: tmpDir,
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
    });

    it("resolves with timedOut: true when the timeout elapses", async () => {
      const start = Date.now();
      const result = await backend.spawn({
        command: "sleep 30",
        cwd: tmpDir,
        signal: AbortSignal.timeout(60_000),
        timeout: 300,
        onOutput: () => {},
      });
      const elapsed = Date.now() - start;
      expect(result.timedOut).toBe(true);
      expect(result.aborted).toBe(false);
      // Should resolve shortly after the 300ms timeout, well under 30s.
      expect(elapsed).toBeLessThan(10_000);
    });
  });

  describe("stat", () => {
    it("distinguishes file vs directory", async () => {
      await fsWriteFile(join(tmpDir, "file.txt"), "hello");
      await mkdir(join(tmpDir, "subdir"));

      const fileStat = await backend.stat(join(tmpDir, "file.txt"));
      expect(fileStat.isFile).toBe(true);
      expect(fileStat.isDirectory).toBe(false);

      const dirStat = await backend.stat(join(tmpDir, "subdir"));
      expect(dirStat.isFile).toBe(false);
      expect(dirStat.isDirectory).toBe(true);
    });

    it("throws ENOENT with .code for a missing path", async () => {
      try {
        await backend.stat(join(tmpDir, "nope"));
        expect.fail("stat should have thrown for a missing path");
      } catch (err: unknown) {
        expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    });
  });

  describe("readFile / writeFile / readdir / exists round-trip", () => {
    it("writes then reads a file (utf8 round-trip)", async () => {
      const filePath = join(tmpDir, "round.txt");
      await backend.writeFile(filePath, "round-trip content");
      const content = await backend.readFile(filePath);
      expect(content).toBe("round-trip content");
    });

    it("readdir lists entries with correct isDirectory flags", async () => {
      await fsWriteFile(join(tmpDir, "a.txt"), "a");
      await mkdir(join(tmpDir, "sub"));

      const entries = await backend.readdir(tmpDir);
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "sub"]);

      const sub = entries.find((e) => e.name === "sub");
      expect(sub?.isDirectory).toBe(true);

      const file = entries.find((e) => e.name === "a.txt");
      expect(file?.isDirectory).toBe(false);
    });

    it("exists returns true for an existing file, false for a missing one", async () => {
      const filePath = join(tmpDir, "exists.txt");
      await fsWriteFile(filePath, "x");
      expect(await backend.exists(filePath)).toBe(true);
      expect(await backend.exists(join(tmpDir, "missing"))).toBe(false);
    });

    it("exists returns true for an existing directory", async () => {
      await mkdir(join(tmpDir, "adir"));
      expect(await backend.exists(join(tmpDir, "adir"))).toBe(true);
    });

    it("readFile throws ENOENT with .code for a missing file", async () => {
      try {
        await backend.readFile(join(tmpDir, "missing.txt"));
        expect.fail("readFile should have thrown for a missing file");
      } catch (err: unknown) {
        expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    });

    it("readdir throws ENOENT with .code for a missing directory", async () => {
      try {
        await backend.readdir(join(tmpDir, "missingdir"));
        expect.fail("readdir should have thrown for a missing directory");
      } catch (err: unknown) {
        expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    });

    it("writeFile throws an error with .code when the parent dir is missing", async () => {
      try {
        await backend.writeFile(join(tmpDir, "missing-parent", "child.txt"), "x");
        expect.fail("writeFile should have thrown for a missing parent dir");
      } catch (err: unknown) {
        expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    });
  });

  describe("singleton", () => {
    it("localExecBackend singleton satisfies ExecBackend and behaves identically", async () => {
      expect(typeof localExecBackend.spawn).toBe("function");
      expect(typeof localExecBackend.readFile).toBe("function");
      const filePath = join(tmpDir, "singleton.txt");
      await localExecBackend.writeFile(filePath, "singleton");
      expect(await localExecBackend.readFile(filePath)).toBe("singleton");
    });
  });
});
