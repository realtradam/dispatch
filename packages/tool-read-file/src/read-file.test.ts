import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExecBackend } from "@dispatch/exec-backend";
import { createLogger, type ToolExecuteContext } from "@dispatch/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReadFileTool,
  formatDirectoryEntries,
  renderLines,
  sliceLines,
  validateArgs,
} from "./read-file.js";

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

/**
 * Build a read_file tool wired to the real local ExecBackend (node:fs,
 * behavior-identical to today's inline calls). No `@dispatch/*` mocking — the
 * real fs edge is exercised, matching the constitution's strict-core rule.
 */
function makeTool(workdir: string) {
  return createReadFileTool({ resolveBackend: () => localExecBackend, workdir });
}

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "tool-read-file-test-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("validateArgs", () => {
  it("returns validated args for valid input", () => {
    const result = validateArgs({ path: "foo.txt" });
    expect(result).toEqual({ path: "foo.txt", offset: 1, limit: 500 });
  });

  it("parses offset and limit", () => {
    const result = validateArgs({ path: "foo.txt", offset: 5, limit: 10 });
    expect(result).toEqual({ path: "foo.txt", offset: 5, limit: 10 });
  });

  it("clamps limit to hard cap of 5000", () => {
    const result = validateArgs({ path: "foo.txt", limit: 99999 });
    expect(result).toEqual({ path: "foo.txt", offset: 1, limit: 5000 });
  });

  it("returns error for null args", () => {
    const result = validateArgs(null);
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing path", () => {
    const result = validateArgs({});
    expect(result).toHaveProperty("error");
  });

  it("returns error for non-string path", () => {
    const result = validateArgs({ path: 123 });
    expect(result).toHaveProperty("error");
  });

  it("returns error for invalid offset", () => {
    const result = validateArgs({ path: "foo.txt", offset: -1 });
    expect(result).toHaveProperty("error");
  });

  it("returns error for invalid limit", () => {
    const result = validateArgs({ path: "foo.txt", limit: 0 });
    expect(result).toHaveProperty("error");
  });
});

describe("sliceLines", () => {
  it("returns all lines with offset=1, limit=500", () => {
    const content = "line1\nline2\nline3";
    const result = sliceLines(content, 1, 500);
    expect(result.lines).toEqual(["line1", "line2", "line3"]);
    expect(result.totalLines).toBe(3);
  });

  it("slices with offset", () => {
    const content = "line1\nline2\nline3\nline4";
    const result = sliceLines(content, 2, 2);
    expect(result.lines).toEqual(["line2", "line3"]);
    expect(result.totalLines).toBe(4);
  });

  it("handles offset beyond content", () => {
    const content = "line1\nline2";
    const result = sliceLines(content, 10, 5);
    expect(result.lines).toEqual([]);
    expect(result.totalLines).toBe(2);
  });

  it("handles single line (no newline)", () => {
    const content = "only line";
    const result = sliceLines(content, 1, 10);
    expect(result.lines).toEqual(["only line"]);
    expect(result.totalLines).toBe(1);
  });
});

describe("renderLines", () => {
  it("renders lines with 1-indexed line numbers", () => {
    const result = renderLines(["a", "b", "c"], 1);
    expect(result).toBe("1: a\n2: b\n3: c");
  });

  it("renders with custom offset", () => {
    const result = renderLines(["x", "y"], 10);
    expect(result).toBe("10: x\n11: y");
  });
});

describe("formatDirectoryEntries", () => {
  it("lists directory entries sorted with trailing slash on subdirectories", () => {
    const entries = [
      { name: "zebra.txt", isDirectory: false },
      { name: "alpha", isDirectory: true },
      { name: "readme.md", isDirectory: false },
      { name: "beta", isDirectory: true },
    ];
    const result = formatDirectoryEntries(entries, "mydir");
    expect(result).toBe("alpha/\nbeta/\nreadme.md\nzebra.txt");
  });

  it("returns empty-directory message for an empty dir", () => {
    const result = formatDirectoryEntries([], "empty-dir");
    expect(result).toBe("(empty directory: empty-dir)");
  });

  it("handles mixed files and directories with same name sorting", () => {
    const entries = [
      { name: "b", isDirectory: false },
      { name: "a", isDirectory: true },
    ];
    const result = formatDirectoryEntries(entries, ".");
    expect(result).toBe("a/\nb");
  });
});

describe("createReadFileTool", () => {
  it("reads a real temp file", async () => {
    const filePath = join(workdir, "hello.txt");
    await writeFile(filePath, "hello\nworld\n", "utf8");

    const tool = makeTool(workdir);
    const result = await tool.execute({ path: "hello.txt" }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1: hello");
    expect(result.content).toContain("2: world");
  });

  it("respects offset and limit", async () => {
    const filePath = join(workdir, "lines.txt");
    await writeFile(filePath, "a\nb\nc\nd\ne\n", "utf8");

    const tool = makeTool(workdir);
    const result = await tool.execute({ path: "lines.txt", offset: 2, limit: 2 }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("2: b\n3: c");
  });

  it("returns error for missing file", async () => {
    const tool = makeTool(workdir);
    const result = await tool.execute({ path: "nonexistent.txt" }, stubCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns empty-file content for empty file", async () => {
    const filePath = join(workdir, "empty.txt");
    await writeFile(filePath, "", "utf8");

    const tool = makeTool(workdir);
    const result = await tool.execute({ path: "empty.txt" }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("empty file");
    expect(result.content).toContain("empty.txt");
  });

  it("returns error for offset beyond file length", async () => {
    const filePath = join(workdir, "short.txt");
    await writeFile(filePath, "one\n", "utf8");

    const tool = makeTool(workdir);
    const result = await tool.execute({ path: "short.txt", offset: 100 }, stubCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exceeds total lines");
  });

  it("never throws on bad input (always returns ToolResult)", async () => {
    const tool = makeTool(workdir);

    const inputs = [null, undefined, 42, "string", {}, { path: "" }, { path: 123 }];
    for (const input of inputs) {
      const result = await tool.execute(input, stubCtx());
      expect(result).toHaveProperty("content");
      expect(typeof result.content).toBe("string");
    }
  });

  it("concurrencySafe is true", () => {
    const tool = makeTool(workdir);
    expect(tool.concurrencySafe).toBe(true);
  });

  it("has correct name and parameters shape", () => {
    const tool = makeTool(workdir);
    expect(tool.name).toBe("read_file");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.required).toEqual(["path"]);
    expect(tool.parameters.properties?.path?.type).toBe("string");
  });

  it("reads file under ctx.cwd when set (not baked workdir)", async () => {
    const ctxDir = await mkdtemp(join(tmpdir(), "ctx-cwd-test-"));
    try {
      const filePath = join(ctxDir, "ctx-file.txt");
      await writeFile(filePath, "from ctx cwd", "utf8");

      const tool = makeTool(workdir); // baked workdir is different
      const result = await tool.execute({ path: "ctx-file.txt" }, stubCtx({ cwd: ctxDir }));

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("1: from ctx cwd");
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  it("falls back to baked workdir when ctx.cwd is omitted", async () => {
    const filePath = join(workdir, "baked-file.txt");
    await writeFile(filePath, "from baked workdir", "utf8");

    const tool = makeTool(workdir);
    const ctx = stubCtx();
    // Ensure cwd is undefined
    expect(ctx.cwd).toBeUndefined();
    const result = await tool.execute({ path: "baked-file.txt" }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1: from baked workdir");
  });

  it("lists directory entries sorted with trailing slash on subdirectories", async () => {
    await mkdir(join(workdir, "subdir"));
    await writeFile(join(workdir, "zebra.txt"), "z", "utf8");
    await writeFile(join(workdir, "alpha.txt"), "a", "utf8");

    const tool = makeTool(workdir);
    const result = await tool.execute({ path: "." }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("alpha.txt\nsubdir/\nzebra.txt");
  });

  it("returns empty-directory message for an empty dir", async () => {
    await mkdir(join(workdir, "empty-dir"));

    const tool = makeTool(workdir);
    const result = await tool.execute({ path: "empty-dir" }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("(empty directory: empty-dir)");
  });

  it("reads a file unchanged (regression: line numbers + offset/limit)", async () => {
    await writeFile(join(workdir, "regression.txt"), "a\nb\nc\nd\ne\n", "utf8");

    const tool = makeTool(workdir);
    const result = await tool.execute({ path: "regression.txt", offset: 2, limit: 3 }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("2: b\n3: c\n4: d");
  });

  it("returns not-found for a nonexistent path", async () => {
    const tool = makeTool(workdir);
    const result = await tool.execute({ path: "nonexistent-path" }, stubCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("routes fs calls through resolveBackend(ctx.computerId) (transport seam)", async () => {
    // A fake backend records what it is asked to do. Proves the tool programs
    // against the ExecBackend surface (not node:fs) and that the resolver is
    // invoked with ctx.computerId — the SSH seam. No real fs involved.
    let statCalls = 0;
    let readFileCalls = 0;
    let readdirCalls = 0;
    let receivedComputerId: string | undefined = "__sentinel__";
    const fakeBackend = {
      spawn: async () => ({ exitCode: 0, timedOut: false, aborted: false }),
      readFile: async (path: string) => {
        readFileCalls++;
        expect(path).toContain("seam.txt");
        return "fake-line-1\nfake-line-2";
      },
      writeFile: async () => {},
      stat: async (path: string) => {
        statCalls++;
        expect(path).toContain("seam.txt");
        return { isFile: true, isDirectory: false };
      },
      readdir: async () => {
        readdirCalls++;
        return [];
      },
      exists: async () => true,
    } as const;

    const tool = createReadFileTool({
      resolveBackend: (computerId) => {
        receivedComputerId = computerId;
        return fakeBackend;
      },
      workdir,
    });
    const result = await tool.execute({ path: "seam.txt" }, stubCtx({ computerId: "prod-ssh" }));

    expect(receivedComputerId).toBe("prod-ssh");
    expect(statCalls).toBe(1);
    expect(readFileCalls).toBe(1);
    expect(readdirCalls).toBe(0);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("1: fake-line-1\n2: fake-line-2");
  });

  it("resolves the local backend when ctx.computerId is undefined (backward compat)", async () => {
    // computerId undefined → resolver returns localExecBackend → real fs.
    const tool = createReadFileTool({ resolveBackend: () => localExecBackend, workdir });
    const filePath = join(workdir, "compat.txt");
    await writeFile(filePath, "real fs via backend\n", "utf8");

    const result = await tool.execute({ path: "compat.txt" }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1: real fs via backend");
  });

  it("preserves ENOENT .code branch through the backend (fake backend throws)", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    const fakeBackend = {
      spawn: async () => ({ exitCode: 0, timedOut: false, aborted: false }),
      readFile: async () => "unused",
      writeFile: async () => {},
      stat: async () => {
        throw enoent;
      },
      readdir: async () => [],
      exists: async () => false,
    } as const;

    const tool = createReadFileTool({ resolveBackend: () => fakeBackend, workdir });
    const result = await tool.execute({ path: "ghost.txt" }, stubCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Error: File "ghost.txt" not found.');
  });
});
