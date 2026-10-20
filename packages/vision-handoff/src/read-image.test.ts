import { resolve as nodeResolve } from "node:path";
import type { ExecBackend, ExecResult } from "@dispatch/exec-backend";
import type { ToolExecuteContext } from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import { READ_IMAGE_MAX_PER_FILE } from "./pure.js";
import { createReadImageTool } from "./read-image.js";

// ── Test doubles (outermost-edge fakes — NOT @dispatch/* mocks) ──────────────

/** A fake ExecBackend whose stat + spawn return canned results. */
function makeBackend(opts: {
  readonly stat?: (path: string) => { isFile: boolean; isDirectory: boolean };
  readonly base64?: (path: string) => string;
}): ExecBackend {
  const stat = opts.stat ?? ((p: string) => ({ isFile: !p.endsWith("/"), isDirectory: false }));
  const base64 = opts.base64 ?? (() => Buffer.from("pixel").toString("base64"));
  return {
    stat: vi.fn(async (path: string) => stat(path)),
    spawn: vi.fn(async (params): Promise<ExecResult> => {
      // Extract the path from `cat '<path>' | base64`.
      const match = params.command.match(/cat '([^']*)' \| base64/);
      const p = match?.[1] ?? "";
      const out = base64(p);
      params.onOutput(out, "stdout");
      return { exitCode: 0, timedOut: false, aborted: false };
    }),
    readFile: vi.fn(async () => ""),
    readFileBytes: vi.fn(async () => new Uint8Array()),
    writeFileAtomic: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    exists: vi.fn(async () => true),
  };
}

/** Minimal ToolExecuteContext for testing. */
function ctx(overrides: Partial<ToolExecuteContext> = {}): ToolExecuteContext {
  const ac = new AbortController();
  return {
    toolCallId: "tc1",
    onOutput: () => {},
    signal: ac.signal,
    log: {
      span: () => ({ end: () => {} }),
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    cwd: "/work",
    ...overrides,
  } as unknown as ToolExecuteContext;
}

describe("read_image tool", () => {
  it("reads a single image and returns text metadata + a native image attachment", async () => {
    const backend = makeBackend({ base64: () => Buffer.from("pixel").toString("base64") });
    const tool = createReadImageTool({ resolveBackend: () => backend });
    const result = await tool.execute({ paths: ["img.png"] }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("img.png");
    expect(result.content).toContain("image/png");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.url).toMatch(/^data:image\/png;base64,/);
    expect(result.images?.[0]?.mimeType).toBe("image/png");
    // backend.stat was called with the cwd-resolved absolute path.
    expect(backend.stat).toHaveBeenCalledWith(nodeResolve("/work", "img.png"));
  });

  it("reads multiple images in one call", async () => {
    const backend = makeBackend({});
    const tool = createReadImageTool({ resolveBackend: () => backend });
    const result = await tool.execute({ paths: ["a.png", "b.jpg"] }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.images).toHaveLength(2);
    expect(result.content).toContain("2 images");
    expect(result.images?.[0]?.mimeType).toBe("image/png");
    expect(result.images?.[1]?.mimeType).toBe("image/jpeg");
  });

  it("resolves relative paths against ctx.cwd", async () => {
    const backend = makeBackend({});
    const tool = createReadImageTool({ resolveBackend: () => backend });
    await tool.execute({ paths: ["sub/x.png"] }, ctx({ cwd: "/projects/app" }));
    expect(backend.stat).toHaveBeenCalledWith(nodeResolve("/projects/app", "sub/x.png"));
  });

  it("rejects an unsupported image type", async () => {
    const backend = makeBackend({});
    const tool = createReadImageTool({ resolveBackend: () => backend });
    const result = await tool.execute({ paths: ["doc.txt"] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a supported image type");
    // spawn never called (rejected before read).
    expect(backend.spawn).not.toHaveBeenCalled();
  });

  it("rejects a missing file (ENOENT from stat)", async () => {
    const backend = makeBackend({
      stat: () => {
        const e = new Error("not found") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      },
    });
    const tool = createReadImageTool({ resolveBackend: () => backend });
    const result = await tool.execute({ paths: ["missing.png"] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("rejects a directory (a path with an image extension that is a directory)", async () => {
    const backend = makeBackend({
      stat: () => ({ isFile: false, isDirectory: true }),
    });
    const tool = createReadImageTool({ resolveBackend: () => backend });
    const result = await tool.execute({ paths: ["somedir.png"] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a regular file");
  });

  it("rejects a path traversal that escapes the working directory", async () => {
    const backend = makeBackend({});
    const tool = createReadImageTool({ resolveBackend: () => backend });
    const result = await tool.execute({ paths: ["../../etc/secret.png"] }, ctx({ cwd: "/work" }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the working directory");
  });

  it("rejects an oversized image (per-file cap)", async () => {
    // base64 of a buffer larger than READ_IMAGE_MAX_PER_FILE.
    const big = Buffer.alloc(READ_IMAGE_MAX_PER_FILE + 1024, 0x41);
    const backend = makeBackend({ base64: () => big.toString("base64") });
    const tool = createReadImageTool({ resolveBackend: () => backend });
    const result = await tool.execute({ paths: ["huge.png"] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("per-image");
  });

  it("routes through resolveBackend(ctx.computerId) — the remote backend seam", async () => {
    // A fake REMOTE backend, selected via ctx.computerId.
    const remoteBackend = makeBackend({
      base64: () => Buffer.from("remote-pixel").toString("base64"),
    });
    const resolveBackend = vi.fn((computerId?: string) => {
      // The tool passes ctx.computerId through — this is the SSH seam.
      expect(computerId).toBe("prod-ssh");
      return remoteBackend;
    });
    const tool = createReadImageTool({ resolveBackend });
    const result = await tool.execute({ paths: ["img.png"] }, ctx({ computerId: "prod-ssh" }));
    expect(result.isError).toBeFalsy();
    expect(resolveBackend).toHaveBeenCalledWith("prod-ssh");
    // The remote backend's stat + spawn were used (not a local node:fs path).
    expect(remoteBackend.stat).toHaveBeenCalled();
    expect(remoteBackend.spawn).toHaveBeenCalled();
    expect(result.images?.[0]?.url).toContain(Buffer.from("remote-pixel").toString("base64"));
  });

  it("rejects a non-object / missing paths argument", async () => {
    const backend = makeBackend({});
    const tool = createReadImageTool({ resolveBackend: () => backend });
    expect((await tool.execute(null, ctx())).isError).toBe(true);
    expect((await tool.execute({}, ctx())).isError).toBe(true);
    expect((await tool.execute({ paths: [] }, ctx())).isError).toBe(true);
  });

  it("errors when no working directory is available", async () => {
    const backend = makeBackend({});
    const tool = createReadImageTool({ resolveBackend: () => backend });
    const result = await tool.execute({ paths: ["img.png"] }, ctx({ cwd: undefined }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No working directory");
  });

  it("surfaces a read failure (non-zero exit) as an error", async () => {
    const backend = makeBackend({});
    (backend.spawn as ReturnType<typeof vi.fn>).mockImplementation(async (_params) => ({
      exitCode: 1,
      timedOut: false,
      aborted: false,
    }));
    const tool = createReadImageTool({ resolveBackend: () => backend });
    const result = await tool.execute({ paths: ["img.png"] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");
  });
});
