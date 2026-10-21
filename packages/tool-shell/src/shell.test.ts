import { readFile } from "node:fs/promises";
import { type ExecBackend, localExecBackend } from "@dispatch/exec-backend";
import { createLogger, type ToolExecuteContext } from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import { buildResult, createRunShellTool, truncateOutput, validateArgs } from "./shell.js";

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

/** A fake backend whose `spawn` resolves a fixed result (no real I/O). */
function fakeBackend(result: {
  exitCode: number | null;
  timedOut: boolean;
  aborted?: boolean;
}): ExecBackend {
  return {
    ...localExecBackend,
    spawn: async () => ({ aborted: false, ...result }),
  };
}

/** Wrap a fake backend in the resolver the factory expects (computerId-agnostic). */
function resolverFor(backend: ExecBackend) {
  return () => backend;
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
    expect(result).toBe(`${"a".repeat(20)}\n…[50 bytes omitted]…\n${"a".repeat(30)}`);
    expect(result.length).toBeLessThan(output.length + 100);
  });
  it("does not retain half a surrogate pair at capture boundaries", () => {
    const result = truncateOutput(`${"a".repeat(19_999)}😀${"b".repeat(30_000)}`, 50_000);
    expect(result).toBe(`${"a".repeat(19_999)}\n…[4 bytes omitted]…\n${"b".repeat(30_000)}`);
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

  it("does not report a null exit code as success", () => {
    expect(
      buildResult({ exitCode: null, timedOut: false, aborted: false, output: "", cap: 50_000 })
        .isError,
    ).toBe(true);
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
    expect(result.content).toContain("bytes omitted]");
    expect(result.content.length).toBeLessThan(60_000);
  });
});

describe("createRunShellTool", () => {
  it("has correct name and parameters shape", () => {
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: resolverFor(fakeBackend({ exitCode: 0, timedOut: false })),
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
      resolveBackend: resolverFor(fakeBackend({ exitCode: 0, timedOut: false })),
    });
    expect(tool.concurrencySafe).toBe(false);
  });

  it("rejects missing or empty command", async () => {
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: resolverFor(fakeBackend({ exitCode: 0, timedOut: false })),
    });
    const result = await tool.execute({}, stubCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Missing or empty");
  });

  it("maps a zero exit code to a success result", async () => {
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: resolverFor({
        ...localExecBackend,
        spawn: async (params) => {
          params.onOutput("hello\n", "stdout");
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
    });
    const result = await tool.execute({ command: "echo hello" }, stubCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("hello");
  });

  it("maps a non-zero exit code to an isError result", async () => {
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: resolverFor({
        ...localExecBackend,
        spawn: async (params) => {
          params.onOutput("error output\n", "stderr");
          return { exitCode: 1, timedOut: false, aborted: false };
        },
      }),
    });
    const result = await tool.execute({ command: "false" }, stubCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("error output");
  });

  it("reports a timeout as an isError result", async () => {
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: resolverFor({
        ...localExecBackend,
        spawn: async (params) => {
          params.onOutput("partial\n", "stdout");
          return { exitCode: null, timedOut: true, aborted: false };
        },
      }),
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
      resolveBackend: resolverFor({
        ...localExecBackend,
        spawn: async (params) => {
          params.onOutput("a".repeat(200), "stdout");
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
    });
    const result = await tool.execute({ command: "gen" }, stubCtx());
    expect(result.content).toContain("bytes omitted]");
    expect(result.content.length).toBeLessThan(200);
  });

  it("streams output to ctx.onOutput", async () => {
    const chunks: Array<{ data: string; stream: "stdout" | "stderr" }> = [];
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: resolverFor({
        ...localExecBackend,
        spawn: async (params) => {
          params.onOutput("line1\n", "stdout");
          params.onOutput("err1\n", "stderr");
          params.onOutput("line2\n", "stdout");
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
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
      resolveBackend: resolverFor({
        ...localExecBackend,
        spawn: async (params) => {
          receivedCwd = params.cwd;
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
    });
    await tool.execute({ command: "pwd" }, stubCtx({ cwd: "/custom" }));
    expect(receivedCwd).toBe("/custom");
  });

  it("falls back to baked workdir when ctx.cwd is omitted", async () => {
    let receivedCwd = "";
    const tool = createRunShellTool({
      workdir: "/baked",
      resolveBackend: resolverFor({
        ...localExecBackend,
        spawn: async (params) => {
          receivedCwd = params.cwd;
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
    });
    await tool.execute({ command: "pwd" }, stubCtx());
    expect(receivedCwd).toBe("/baked");
  });

  it("returns error for spawn failure", async () => {
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: resolverFor({
        ...localExecBackend,
        spawn: async () => {
          throw new Error("spawn failed");
        },
      }),
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
      resolveBackend: resolverFor(fakeBackend({ exitCode: 0, timedOut: false })),
    });
    const result = await tool.execute({ command: "test" }, stubCtx({ signal: controller.signal }));
    expect(result.isError).toBe(true);
  });

  it("passes timeout to spawn", async () => {
    let receivedTimeout = 0;
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: resolverFor({
        ...localExecBackend,
        spawn: async (params) => {
          receivedTimeout = params.timeout;
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
    });
    await tool.execute({ command: "test", timeout: 5000 }, stubCtx());
    expect(receivedTimeout).toBe(5000);
  });

  it("resolves the backend per-call from ctx.computerId (passes it to the resolver)", async () => {
    let receivedComputerId: string | undefined = "__unset__";
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: (computerId) => {
        receivedComputerId = computerId;
        return fakeBackend({ exitCode: 0, timedOut: false });
      },
    });
    await tool.execute({ command: "test" }, stubCtx({ computerId: "my-host" }));
    expect(receivedComputerId).toBe("my-host");
  });

  it("resolves the local backend when ctx.computerId is undefined", async () => {
    let receivedComputerId: string | undefined = "__unset__";
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: (computerId) => {
        receivedComputerId = computerId;
        return fakeBackend({ exitCode: 0, timedOut: false });
      },
    });
    await tool.execute({ command: "test" }, stubCtx());
    expect(receivedComputerId).toBeUndefined();
  });
});

describe("bounded shell output", () => {
  it("retains head/tail and counts omitted UTF-8 bytes across many chunks", async () => {
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: () => ({
        ...localExecBackend,
        spawn: async ({ onOutput }) => {
          onOutput("H".repeat(20_000), "stdout");
          for (let i = 0; i < 100; i++) onOutput("é".repeat(1000), "stderr");
          onOutput("T".repeat(30_000), "stdout");
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
    });
    const result = await tool.execute({ command: "test" }, stubCtx());
    expect(result.content).toBe(
      `${"H".repeat(20_000)}\n…[200000 bytes omitted]…\n${"T".repeat(30_000)}`,
    );
  });

  it("coalesces small output at 100ms, flushes 8KB, and flushes on completion", async () => {
    vi.useFakeTimers();
    try {
      const chunks: string[] = [];
      const tool = createRunShellTool({
        workdir: "/tmp",
        resolveBackend: () => ({
          ...localExecBackend,
          spawn: async ({ onOutput }) => {
            onOutput("a", "stdout");
            onOutput("b", "stdout");
            await vi.advanceTimersByTimeAsync(99);
            expect(chunks).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            expect(chunks).toEqual(["ab"]);
            onOutput("x".repeat(8000), "stdout");
            expect(chunks.at(-1)?.length).toBe(8000);
            onOutput("end", "stdout");
            return { exitCode: 0, timedOut: false, aborted: false };
          },
        }),
      });
      await tool.execute({ command: "test" }, stubCtx({ onOutput: (s) => chunks.push(s) }));
      expect(chunks.at(-1)).toBe("end");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps streaming at 1MB plus one note without breaking UTF-8", async () => {
    const chunks: string[] = [];
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: () => ({
        ...localExecBackend,
        spawn: async ({ onOutput }) => {
          for (let i = 0; i < 500; i++) onOutput("😀".repeat(1001), "stdout");
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
    });
    await tool.execute({ command: "test" }, stubCtx({ onOutput: (s) => chunks.push(s) }));
    const note = "\n[streaming truncated at 1 MB]\n";
    expect(chunks.filter((s) => s === note)).toHaveLength(1);
    expect(Buffer.byteLength(chunks.join(""))).toBe(1_000_000 + note.length);
    expect(chunks.join("")).not.toContain("�");
    expect(chunks.every((s) => Buffer.byteLength(s) <= 8000)).toBe(true);
  });

  it("preserves BOMs and multibyte characters at 8KB streaming boundaries", async () => {
    let streamed = "";
    const text = `\uFEFF${"é".repeat(3998)}😀${"€".repeat(1000)}`;
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: () => ({
        ...localExecBackend,
        spawn: async ({ onOutput }) => {
          onOutput(text, "stdout");
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
    });
    const result = await tool.execute(
      { command: "test" },
      stubCtx({
        onOutput: (s) => {
          streamed += s;
        },
      }),
    );
    expect(streamed).toBe(text);
    expect(result.content).toBe(text);
  });

  it("preserves every alternating-stream run in arrival order", async () => {
    const chunks: string[] = [];
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: () => ({
        ...localExecBackend,
        spawn: async ({ onOutput }) => {
          for (let i = 0; i < 1000; i++) {
            onOutput("a", "stdout");
            onOutput("b", "stderr");
          }
          return { exitCode: 0, timedOut: false, aborted: false };
        },
      }),
    });
    const result = await tool.execute(
      { command: "test" },
      stubCtx({ onOutput: (s) => chunks.push(s) }),
    );
    expect(chunks).toEqual(Array.from({ length: 1000 }, () => ["a", "b"]).flat());
    expect(result.content).toBe("ab".repeat(1000));
  });

  it("coalesces only consecutive runs across timer, byte-boundary and final flushes", async () => {
    vi.useFakeTimers();
    try {
      const chunks: Array<{ data: string; stream: "stdout" | "stderr" }> = [];
      const expected = [
        { data: "out1out2", stream: "stdout" },
        { data: "err1err2", stream: "stderr" },
        { data: "out3", stream: "stdout" },
        { data: "é".repeat(3999), stream: "stderr" },
        { data: "😀!", stream: "stdout" },
        { data: "last", stream: "stderr" },
      ];
      const tool = createRunShellTool({
        workdir: "/tmp",
        resolveBackend: () => ({
          ...localExecBackend,
          spawn: async ({ onOutput }) => {
            onOutput("out1", "stdout");
            onOutput("out2", "stdout");
            onOutput("err1", "stderr");
            onOutput("err2", "stderr");
            onOutput("out3", "stdout");
            expect(chunks).toEqual([]);
            await vi.advanceTimersByTimeAsync(100);
            expect(chunks).toEqual(expected.slice(0, 3));
            onOutput("é".repeat(3999), "stderr");
            onOutput("😀", "stdout"); // Won't fit: flush before this character.
            expect(chunks).toEqual(expected.slice(0, 4));
            onOutput("!", "stdout");
            onOutput("last", "stderr");
            return { exitCode: 0, timedOut: false, aborted: false };
          },
        }),
      });
      const result = await tool.execute(
        { command: "test" },
        stubCtx({ onOutput: (data, stream) => chunks.push({ data, stream }) }),
      );
      expect(chunks).toEqual(expected);
      expect(result.content).toBe(expected.map(({ data }) => data).join(""));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up the streaming timer when spawn rejects", async () => {
    vi.useFakeTimers();
    try {
      const tool = createRunShellTool({
        workdir: "/tmp",
        resolveBackend: () => ({
          ...localExecBackend,
          spawn: async ({ onOutput }) => {
            onOutput("partial", "stdout");
            throw new Error("failure");
          },
        }),
      });
      const result = await tool.execute({ command: "test" }, stubCtx());
      expect(result.isError).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createRunShellTool (integration)", () => {
  it("kills the process group beyond 50MB and bounds captured and streamed output", async () => {
    const chunks: string[] = [];
    const tool = createRunShellTool({ workdir: "/tmp", resolveBackend: () => localExecBackend });
    const result = await tool.execute(
      { command: "sleep 30 & echo GROUP:$$ CHILD:$!; yes | head -c 200000000", timeout: 10_000 },
      stubCtx({ signal: AbortSignal.timeout(15_000), onOutput: (s) => chunks.push(s) }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("output exceeded 50 MB");
    expect(result.content).not.toContain("timed out");
    expect(result.content.length).toBeLessThan(50_150);
    expect(Buffer.byteLength(chunks.join(""))).toBeLessThan(1_000_100);
    const pids = /GROUP:(\d+) CHILD:(\d+)/.exec(result.content);
    expect(pids).not.toBeNull();
    if (!pids) return;
    const running = async (pid: string) => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        return stat.split(") ")[1]?.[0] !== "Z";
      } catch {
        return false;
      }
    };
    try {
      await vi.waitFor(async () => {
        expect(await running(pids[1] ?? "")).toBe(false);
        expect(await running(pids[2] ?? "")).toBe(false);
      });
    } finally {
      try {
        process.kill(-Number(pids[1]), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 20_000);

  it.each([
    { command: "echo hi", cwd: "/missing-shell-cwd", note: "spawn failed:" },
    { command: "kill -KILL $$", cwd: "/tmp", note: "[killed by SIGKILL]" },
  ])("reports $note as an error", async ({ command, cwd, note }) => {
    const tool = createRunShellTool({ workdir: cwd, resolveBackend: () => localExecBackend });
    const result = await tool.execute({ command }, stubCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain(note);
  });

  it("runs a real echo command through the local backend and captures stdout + cwd", async () => {
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: () => localExecBackend,
    });
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

  it("aborts a real long-running command through the local backend and resolves with aborted", async () => {
    const controller = new AbortController();
    const tool = createRunShellTool({
      workdir: "/tmp",
      resolveBackend: () => localExecBackend,
    });
    const promise = tool.execute({ command: "sleep 30" }, stubCtx({ signal: controller.signal }));
    // Let the sleep actually start.
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const result = await promise;
    expect(result.isError).toBe(true);
    // The detailed process-group-kill semantics (grandchild holding the pipes,
    // prompt resolution) are owned by @dispatch/exec-backend's local.test.ts —
    // realSpawn was ported there byte-for-byte. Here we only confirm the tool
    // wires the backend's aborted result through to an isError result.
    await new Promise((r) => setTimeout(r, 200));
  });
});
