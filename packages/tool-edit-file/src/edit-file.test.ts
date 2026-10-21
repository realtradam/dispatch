import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExecBackend } from "@dispatch/exec-backend";
import { createLogger, type ToolExecuteContext } from "@dispatch/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeReplacement,
  createEditFileTool,
  type QueueCheckHook,
  validateArgs,
} from "./edit-file.js";

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

/** No-op queue hook — the post-edit LSP background check. */
const noopQueueCheck: QueueCheckHook = () => {};

/**
 * Build an edit_file tool wired to the real local ExecBackend (node:fs,
 * behavior-identical to today's inline calls) and a no-op queue hook.
 * No `@dispatch/*` mocking — the real fs edge is exercised, matching the
 * constitution's strict-core rule. Tests that need a real queue hook build
 * the tool inline.
 */
function makeTool(
  queueCheck: QueueCheckHook = noopQueueCheck,
): ReturnType<typeof createEditFileTool> {
  return createEditFileTool({
    resolveBackend: () => localExecBackend,
    workdir,
    queueCheck,
  });
}

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "tool-edit-file-test-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("validateArgs", () => {
  it("returns validated args for valid input", () => {
    const result = validateArgs({ path: "f.txt", oldString: "a", newString: "b" });
    expect(result).toEqual({ path: "f.txt", oldString: "a", newString: "b", replaceAll: false });
  });

  it("parses replaceAll true", () => {
    const result = validateArgs({
      path: "f.txt",
      oldString: "a",
      newString: "b",
      replaceAll: true,
    });
    expect(result).toEqual({ path: "f.txt", oldString: "a", newString: "b", replaceAll: true });
  });

  it("defaults replaceAll to false when omitted", () => {
    const result = validateArgs({ path: "f.txt", oldString: "a", newString: "b" });
    expect(result).toHaveProperty("replaceAll", false);
  });

  it("returns error for null args", () => {
    const result = validateArgs(null);
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing path", () => {
    const result = validateArgs({ oldString: "a", newString: "b" });
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing oldString", () => {
    const result = validateArgs({ path: "f.txt", newString: "b" });
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing newString", () => {
    const result = validateArgs({ path: "f.txt", oldString: "a" });
    expect(result).toHaveProperty("error");
  });

  it("returns error for non-string path", () => {
    const result = validateArgs({ path: 123, oldString: "a", newString: "b" });
    expect(result).toHaveProperty("error");
  });

  it("returns error for non-string oldString", () => {
    const result = validateArgs({ path: "f.txt", oldString: 123, newString: "b" });
    expect(result).toHaveProperty("error");
  });
});

describe("computeReplacement", () => {
  it("keeps uniqueness and identical checks after CRLF normalization", () => {
    expect(computeReplacement("a\r\nb a\r\nb", "a\nb", "x", false)).toEqual({
      kind: "notUnique",
      count: 2,
    });
    expect(computeReplacement("a\r\nb", "a\nb", "a\r\nb", false)).toEqual({ kind: "identical" });
    expect(computeReplacement("a\nb", "a\nb", "c\nd", false)).toEqual({
      content: "c\nd",
      count: 1,
    });
  });

  it.each([
    { content: "header\r\na\nb\n", old: "a\nb", replacement: "x\ny", expected: "header\r\nx\ny\n" },
    {
      content: "a\nb\nother\r\na\r\nb",
      old: "a\nb",
      replacement: "x\ny",
      expected: "x\ny\nother\r\na\r\nb",
    },
    {
      content: "a\r\nb\nother\na\nb",
      old: "a\r\nb",
      replacement: "x\ny",
      expected: "x\r\ny\nother\na\nb",
    },
    {
      content: "header\r\na\nb\n",
      old: "a\r\nb",
      replacement: "x\r\ny",
      expected: "header\r\nx\ny\n",
    },
    { content: "a\r\nb\nc", old: "a\nb\nc", replacement: "x\ny", expected: "x\r\ny" },
    { content: "top\r\na\nb", old: "a", replacement: "x\r\ny", expected: "top\r\nx\ny\nb" },
    { content: "top\r\na", old: "a", replacement: "x\ny", expected: "top\r\nx\r\ny" },
    { content: "a\nb", old: "a\nb", replacement: "x\r\ny", expected: "x\ny" },
  ])("uses the matched region EOL: $content / $old", ({ content, old, replacement, expected }) => {
    expect(computeReplacement(content, old, replacement, false)).toEqual({
      content: expected,
      count: 1,
    });
  });

  it("adapts replaceAll insertions to each single-line match's local EOL", () => {
    expect(computeReplacement("a\nb\r\na\r\nb", "a", "x\ny", true)).toEqual({
      content: "x\ny\nb\r\nx\r\ny\r\nb",
      count: 2,
    });
  });

  it("treats regex and replacement metacharacters literally in the fallback", () => {
    expect(computeReplacement("[a].*\r\n(b)$", "[a].*\n(b)$", "$&\n$1", false)).toEqual({
      content: "$&\r\n$1",
      count: 1,
    });
  });

  it("checks fallback uniqueness across both EOL conventions", () => {
    expect(computeReplacement("a\r\nb\nc a\nb\r\nc", "a\nb\nc", "x", false)).toEqual({
      kind: "notUnique",
      count: 2,
    });
  });

  it("replaces a single occurrence", () => {
    const result = computeReplacement("hello world", "world", "there", false);
    expect(result).toEqual({ content: "hello there", count: 1 });
  });

  it("replaces all occurrences when replaceAll is true", () => {
    const result = computeReplacement("aaa", "a", "b", true);
    expect(result).toEqual({ content: "bbb", count: 3 });
  });

  it("returns identical error when newString equals oldString", () => {
    const result = computeReplacement("hello", "hello", "hello", false);
    expect(result).toEqual({ kind: "identical" });
  });

  it("returns notFound error when oldString is not in content", () => {
    const result = computeReplacement("hello", "xyz", "abc", false);
    expect(result).toEqual({ kind: "notFound" });
  });

  it("returns notUnique error when oldString occurs multiple times and replaceAll is false", () => {
    const result = computeReplacement("abc abc abc", "abc", "xyz", false);
    expect(result).toEqual({ kind: "notUnique", count: 3 });
  });

  it("replaces only the single match when unique", () => {
    const result = computeReplacement("foo bar baz", "bar", "qux", false);
    expect(result).toEqual({ content: "foo qux baz", count: 1 });
  });

  it("handles replaceAll with multiple occurrences", () => {
    const result = computeReplacement("one two one two", "two", "three", true);
    expect(result).toEqual({ content: "one three one three", count: 2 });
  });

  it("handles empty oldString as notFound (empty string not searched)", () => {
    // empty oldString would cause infinite loop in split, so we treat it as not-found
    const result = computeReplacement("hello", "", "x", false);
    expect(result).toEqual({ kind: "notFound" });
  });

  it("handles oldString at start of content", () => {
    const result = computeReplacement("hello world", "hello", "goodbye", false);
    expect(result).toEqual({ content: "goodbye world", count: 1 });
  });

  it("handles oldString at end of content", () => {
    const result = computeReplacement("hello world", "world", "there", false);
    expect(result).toEqual({ content: "hello there", count: 1 });
  });

  it("handles multiline oldString and newString", () => {
    const content = "line1\nold line\nline3";
    const result = computeReplacement(content, "old line", "new line", false);
    expect(result).toEqual({ content: "line1\nnew line\nline3", count: 1 });
  });
});

describe("createEditFileTool", () => {
  it.each([
    Buffer.from([0xff]),
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0xe2, 0x82]),
  ])("refuses invalid UTF-8 %j without replacing the file or changing any bytes", async (invalid) => {
    const path = join(workdir, "invalid.txt");
    const bytes = Buffer.from([0x61, ...invalid, 0x62]);
    await writeFile(path, bytes);
    const before = await stat(path);
    const result = await makeTool().execute(
      { path, oldString: "a", newString: "changed" },
      stubCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not valid UTF-8");
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).ino).toBe(before.ino);
    expect(await readdir(workdir)).toEqual(["invalid.txt"]);
  });

  it.each([
    { oldString: "one\ntwo", newString: "new\nlines", replaceAll: true },
    { oldString: "one\r\ntwo", newString: "new\r\nlines", replaceAll: true },
    { oldString: "one", newString: "new\nlines", replaceAll: false },
  ])("preserves CRLF and BOM with $oldString", async (args) => {
    const path = join(workdir, "crlf.txt");
    await writeFile(path, "\ufeffone\r\ntwo\r\none\r\ntwo\r\n");
    const input = args.replaceAll ? undefined : "\ufeffone\r\ntwo\r\n";
    if (input) await writeFile(path, input);
    const result = await makeTool().execute({ path, ...args }, stubCtx());
    expect(result.isError).toBeUndefined();
    const expected = args.replaceAll
      ? "\ufeffnew\r\nlines\r\nnew\r\nlines\r\n"
      : "\ufeffnew\r\nlines\r\ntwo\r\n";
    expect(await readFile(path)).toEqual(Buffer.from(expected));
  });

  it("atomically edits an LF region in mixed-EOL UTF-8 while preserving bytes and mode", async () => {
    const path = join(workdir, "mixed.sh");
    await writeFile(path, "\ufeffheader\r\nold\nlines\nuntouched é\r\n");
    await chmod(path, 0o751);
    const before = await stat(path);
    const result = await makeTool().execute(
      { path, oldString: "old\nlines", newString: "new\ntext" },
      stubCtx(),
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(path)).toEqual(Buffer.from("\ufeffheader\r\nnew\ntext\nuntouched é\r\n"));
    expect((await stat(path)).mode & 0o7777).toBe(0o751);
    expect((await stat(path)).ino).not.toBe(before.ino);
    expect(await readdir(workdir)).toEqual(["mixed.sh"]);
  });

  it("preserves executable mode and atomically replaces the file", async () => {
    const path = join(workdir, "script.sh");
    await writeFile(path, "echo old\n");
    await chmod(path, 0o751);
    const before = await stat(path);
    expect(
      (await makeTool().execute({ path, oldString: "old", newString: "new" }, stubCtx())).isError,
    ).toBeUndefined();
    const after = await stat(path);
    expect(after.mode & 0o7777).toBe(0o751);
    expect(after.ino).not.toBe(before.ino);
    expect(await readFile(path, "utf8")).toBe("echo new\n");
    expect(await readdir(workdir)).toEqual(["script.sh"]);
  });

  it("replaces a single occurrence", async () => {
    const filePath = join(workdir, "test.txt");
    await writeFile(filePath, "hello world\n", "utf8");

    const tool = makeTool();
    const result = await tool.execute(
      { path: "test.txt", oldString: "world", newString: "there" },
      stubCtx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Replaced 1 occurrence");

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("hello there\n");
  });

  it("replaces all occurrences when replaceAll is true", async () => {
    const filePath = join(workdir, "test.txt");
    await writeFile(filePath, "aaa\n", "utf8");

    const tool = makeTool();
    const result = await tool.execute(
      { path: "test.txt", oldString: "a", newString: "b", replaceAll: true },
      stubCtx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Replaced 3 occurrences");

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("bbb\n");
  });

  it("errors when oldString is not found", async () => {
    const filePath = join(workdir, "test.txt");
    await writeFile(filePath, "hello\n", "utf8");

    const tool = makeTool();
    const result = await tool.execute(
      { path: "test.txt", oldString: "xyz", newString: "abc" },
      stubCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("oldString not found");
  });

  it("errors when oldString is non-unique and replaceAll is false", async () => {
    const filePath = join(workdir, "test.txt");
    await writeFile(filePath, "abc abc abc\n", "utf8");

    const tool = makeTool();
    const result = await tool.execute(
      { path: "test.txt", oldString: "abc", newString: "xyz" },
      stubCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Found 3 matches");
  });

  it("errors when newString equals oldString", async () => {
    const filePath = join(workdir, "test.txt");
    await writeFile(filePath, "hello\n", "utf8");

    const tool = makeTool();
    const result = await tool.execute(
      { path: "test.txt", oldString: "hello", newString: "hello" },
      stubCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("newString must differ from oldString");
  });

  it("errors / not-found for a nonexistent file", async () => {
    const tool = makeTool();
    const result = await tool.execute(
      { path: "nonexistent.txt", oldString: "a", newString: "b" },
      stubCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("reads file under ctx.cwd when set", async () => {
    const ctxDir = await mkdtemp(join(tmpdir(), "ctx-cwd-test-"));
    try {
      const filePath = join(ctxDir, "ctx-file.txt");
      await writeFile(filePath, "hello world", "utf8");

      const tool = makeTool();
      const result = await tool.execute(
        { path: "ctx-file.txt", oldString: "world", newString: "there" },
        stubCtx({ cwd: ctxDir }),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Replaced 1 occurrence");

      const content = await readFile(filePath, "utf8");
      expect(content).toBe("hello there");
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  it("falls back to baked workdir when ctx.cwd is omitted", async () => {
    const filePath = join(workdir, "baked-file.txt");
    await writeFile(filePath, "hello world", "utf8");

    const tool = makeTool();
    const ctx = stubCtx();
    expect(ctx.cwd).toBeUndefined();
    const result = await tool.execute(
      { path: "baked-file.txt", oldString: "world", newString: "there" },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Replaced 1 occurrence");
  });

  it("never throws on bad input (always returns ToolResult)", async () => {
    const tool = makeTool();

    const inputs = [null, undefined, 42, "string", {}, { path: "" }, { path: 123 }];
    for (const input of inputs) {
      const result = await tool.execute(input, stubCtx());
      expect(result).toHaveProperty("content");
      expect(typeof result.content).toBe("string");
    }
  });

  it("concurrencySafe is false", () => {
    const tool = makeTool();
    expect(tool.concurrencySafe).toBe(false);
  });

  it("has correct name and parameters shape", () => {
    const tool = makeTool();
    expect(tool.name).toBe("edit_file");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.required).toEqual(["path", "oldString", "newString"]);
    expect(tool.parameters.properties?.path?.type).toBe("string");
    expect(tool.parameters.properties?.oldString?.type).toBe("string");
    expect(tool.parameters.properties?.newString?.type).toBe("string");
    expect(tool.parameters.properties?.replaceAll?.type).toBe("boolean");
  });

  it("queues a background diagnostics check after a local edit (fire-and-forget)", async () => {
    const filePath = join(workdir, "diag.txt");
    await writeFile(filePath, "hello world\n", "utf8");

    const queued: Parameters<QueueCheckHook>[0][] = [];
    const queueCheck: QueueCheckHook = (opts) => {
      queued.push(opts);
    };
    const tool = makeTool(queueCheck);

    const result = await tool.execute(
      { path: "diag.txt", oldString: "world", newString: "there" },
      stubCtx({ conversationId: "conv-1" }),
    );

    expect(result.isError).toBeUndefined();
    // The edit result carries NO diagnostics — the check is asynchronous.
    expect(result.content).toBe('Replaced 1 occurrence in "diag.txt".');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.conversationId).toBe("conv-1");
    expect(queued[0]?.filePath).toBe(filePath);
    expect(queued[0]?.text).toBe("hello there\n");
    expect(queued[0]?.cwd).toBe(process.cwd());
  });

  it("returns immediately: a check that never completes cannot delay the edit", async () => {
    const filePath = join(workdir, "async.txt");
    await writeFile(filePath, "hello\n", "utf8");

    let checkStillRunning = true;
    const queueCheck: QueueCheckHook = () => {
      // Model a long-running check: the hook has no way to return a promise,
      // so the edit cannot await it.
      void new Promise<void>((resolve) => setTimeout(resolve, 60_000)).then(() => {
        checkStillRunning = false;
      });
    };
    const tool = makeTool(queueCheck);

    const result = await tool.execute(
      { path: "async.txt", oldString: "hello", newString: "hi" },
      stubCtx({ conversationId: "conv-1" }),
    );

    expect(result.content).toBe('Replaced 1 occurrence in "async.txt".');
    expect(checkStillRunning).toBe(true);
  });

  it("skips the check when computerId is set (remote)", async () => {
    const filePath = join(workdir, "remote.txt");
    await writeFile(filePath, "hello\n", "utf8");

    let called = false;
    const queueCheck: QueueCheckHook = () => {
      called = true;
    };
    const tool = makeTool(queueCheck);

    const result = await tool.execute(
      { path: "remote.txt", oldString: "hello", newString: "hi" },
      stubCtx({ computerId: "remote-host", conversationId: "conv-1" }),
    );

    // Remote: LSP servers are local processes that can't see SFTP files.
    expect(called).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Replaced 1 occurrence in "remote.txt".');

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("hi\n");
  });

  it("skips the check when there is no conversation to notify", async () => {
    const filePath = join(workdir, "noconv.txt");
    await writeFile(filePath, "hello\n", "utf8");

    let called = false;
    const tool = makeTool(() => {
      called = true;
    });

    const result = await tool.execute(
      { path: "noconv.txt", oldString: "hello", newString: "hi" },
      stubCtx(), // conversationId omitted
    );

    expect(called).toBe(false);
    expect(result.content).toBe('Replaced 1 occurrence in "noconv.txt".');
  });

  it("swallows a throwing queue hook (edit already succeeded)", async () => {
    const filePath = join(workdir, "throw.txt");
    await writeFile(filePath, "hello\n", "utf8");

    const tool = makeTool(() => {
      throw new Error("LSP exploded");
    });

    const result = await tool.execute(
      { path: "throw.txt", oldString: "hello", newString: "hi" },
      stubCtx({ conversationId: "conv-1" }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Replaced 1 occurrence in "throw.txt".');
  });
});

describe("edit_file — LSP failure containment", () => {
  it("succeeds with NO LSP hook at all (LSP absent or failed to activate)", async () => {
    const filePath = join(workdir, "no-lsp.txt");
    await writeFile(filePath, "hello\n", "utf8");

    // Exactly the shape the extension builds when `tryGetService` finds no LSP
    // service: the optional hook is simply absent.
    const tool = createEditFileTool({ resolveBackend: () => localExecBackend, workdir });
    const result = await tool.execute(
      { path: "no-lsp.txt", oldString: "hello", newString: "hi" },
      stubCtx({ conversationId: "conv-1" }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Replaced 1 occurrence in "no-lsp.txt".');
    expect(await readFile(filePath, "utf8")).toBe("hi\n");
  });

  it("a throwing LSP hook (broken service) never breaks the edit or the file write", async () => {
    const filePath = join(workdir, "broken-lsp.txt");
    await writeFile(filePath, "hello\n", "utf8");

    const tool = makeTool(() => {
      throw new Error("LSP extension exploded");
    });
    const result = await tool.execute(
      { path: "broken-lsp.txt", oldString: "hello", newString: "hi" },
      stubCtx({ conversationId: "conv-1" }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Replaced 1 occurrence in "broken-lsp.txt".');
    // The edit is fully applied despite the LSP failure.
    expect(await readFile(filePath, "utf8")).toBe("hi\n");
  });
});
