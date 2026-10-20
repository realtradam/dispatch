import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createCredentialStoreExtension } from "@dispatch/credential-store";
import { createBus, createHost, createLogger, type LogRecord } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { containedPath, createImageFileStore, createVisionExtension } from "./extension.js";

const dataUrl = "data:image/png;base64,aW1hZ2U=";

describe("containedPath", () => {
  it.each([
    "..",
    "../images-sibling/file.png",
    "/outside/file.png",
    "%2e%2e",
    "..%2Foutside",
    "%252e%252e",
    "bad\0name",
  ])("rejects unsafe segment %j", (segment) => {
    expect(containedPath("/tmp/images", segment)).toBeNull();
  });

  it("checks the final path, not a string prefix or an intermediate segment", () => {
    expect(containedPath("/tmp/images", "conv", "../../images-other/a.png")).toBeNull();
    expect(containedPath("/tmp/images", "conv", "/outside/a.png")).toBeNull();
  });

  it("normalizes the root and permits the root itself and normal descendants", () => {
    const root = resolve("relative-images");
    expect(containedPath("relative-images/")).toBe(root);
    expect(containedPath(root, "conv", "a.png")).toBe(join(root, "conv", "a.png"));
    expect(containedPath(sep, "conv", "a.png")).toBe(resolve(sep, "conv", "a.png"));
  });
});

describe("vision image filesystem containment (without transport validation)", () => {
  async function withStore(
    run: (
      store: ReturnType<typeof createImageFileStore>,
      root: string,
      outside: string,
    ) => Promise<void>,
  ) {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-image-containment-"));
    const root = join(dir, "images");
    const outside = join(dir, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.png"), "outside");
    try {
      await run(createImageFileStore(root), root, outside);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("saves, resolves and deletes normal image paths", async () => {
    await withStore(async (store, root) => {
      const url = await store.saveImageToTmp("mcp-test-001", dataUrl);
      expect(url).toMatch(/^\/images\/mcp-test-001\/[A-Za-z0-9-]+\.png$/);
      expect(await store.resolveImageUrl(url)).toBe(dataUrl);
      await store.deleteTmpImage(url);
      expect(await readdir(join(root, "mcp-test-001"))).toEqual([]);
      await store.saveImageToTmp("mcp-test-001", dataUrl);
      await store.deleteConversationImages("mcp-test-001");
      expect(await readdir(root)).toEqual([]);
    });
  });

  it("refuses escaped writes and recursive deletes, including the root itself", async () => {
    await withStore(async (store, root, outside) => {
      for (const id of ["../outside", outside, "%2e%2e%2foutside"]) {
        await expect(store.saveImageToTmp(id, dataUrl)).rejects.toThrow("Invalid image path");
        await expect(store.deleteConversationImages(id)).rejects.toThrow("Invalid image path");
      }
      await store.saveImageToTmp("keep", dataUrl);
      for (const id of ["", ".", "keep/..", root]) {
        await expect(store.deleteConversationImages(id)).rejects.toThrow("Invalid image path");
      }
      expect(await readFile(join(outside, "sentinel.png"), "utf8")).toBe("outside");
      expect(await readdir(root)).toEqual(["keep"]);
      expect(await readdir(outside)).toEqual(["sentinel.png"]);
    });
  });

  it("refuses traversal reads and unlinks, including encoded and extra URL segments", async () => {
    await withStore(async (store, _root, outside) => {
      for (const url of [
        "/images/../outside/sentinel.png",
        "/images/../sentinel.png",
        "/images/%2e%2e%2foutside/sentinel.png",
        "/images/conv/..%2f..%2foutside%2fsentinel.png",
        "/images/conv/%252e%252e%252fsentinel.png",
      ]) {
        await expect(store.resolveImageUrl(url)).rejects.toThrow("Invalid image path");
        await expect(store.deleteTmpImage(url)).rejects.toThrow("Invalid image path");
      }
      expect(await readFile(join(outside, "sentinel.png"), "utf8")).toBe("outside");
    });
  });

  it("preserves data and external URLs", async () => {
    await withStore(async (store) => {
      for (const url of [dataUrl, "https://example.com/image.png", "/other/image.png"]) {
        expect(await store.resolveImageUrl(url)).toBe(url);
        await store.deleteTmpImage(url);
      }
    });
  });
});

it("migrates exclusively/idempotently with original ages, sweeps old images, and ignores symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-retention-"));
  const root = join(dir, "images"),
    legacy = join(dir, "legacy");
  const now = Date.now(),
    day = 86_400_000;
  try {
    await mkdir(join(legacy, "conv"), { recursive: true });
    for (const [name, age] of [
      ["old.png", 8],
      ["recent.png", 1],
      ["existing.png", 1],
    ] as const) {
      const path = join(legacy, "conv", name);
      await writeFile(path, name);
      await utimes(path, (now - age * day) / 1000, (now - age * day) / 1000);
    }
    await mkdir(join(root, "conv"), { recursive: true });
    await writeFile(join(root, "conv", "existing.png"), "keep destination");
    await symlink(legacy, join(root, "link"));
    const files = createImageFileStore(root);
    await files.migrate(legacy, now, 7);
    await files.migrate(legacy, now, 7);
    expect(await readdir(join(root, "conv"))).toEqual(["existing.png", "recent.png"]);
    expect(await readFile(join(root, "conv", "existing.png"), "utf8")).toBe("keep destination");
    expect((await stat(join(root, "conv", "recent.png"))).mtimeMs).toBeCloseTo(now - day, 0);
    expect(await files.sweep(now + 8 * day, 0)).toEqual({ deleted: 0, bytesFreed: 0 });
    const fresh = await files.saveImageToTmp("fresh", dataUrl);
    await utimes(
      join(root, fresh.slice("/images/".length)),
      (now + 8 * day) / 1000,
      (now + 8 * day) / 1000,
    );
    expect(await files.sweep(now + 8 * day, 7)).toEqual({ deleted: 2, bytesFreed: 26 });
    expect(await readdir(root)).toEqual(["fresh", "link"]);
    expect(await files.resolveImageUrl(fresh)).toBe(dataUrl);
    expect(await readdir(join(legacy, "conv"))).toHaveLength(3);
    await files.migrate(legacy, now, 0);
    expect(await readdir(join(root, "conv"))).toHaveLength(3);
    await files.migrate(root, now, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("sweeps at activation and on the six-hour timer, then unloads without dangling registrations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-image-lifecycle-"));
  const root = join(dir, "images");
  let now = Date.now(),
    tick = () => {},
    cancelled = false;
  const records: LogRecord[] = [];
  const sink = {
    emit: (record: LogRecord) => {
      records.push(record);
    },
  };
  const logDeps = { now: () => now, newId: () => "test" };
  const host = createHost(
    [
      createCredentialStoreExtension({ credentials: [] }),
      createVisionExtension({
        legacyDir: join(dir, "absent"),
        now: () => now,
        schedule: (fn, ms) => {
          expect(ms).toBe(6 * 60 * 60 * 1000);
          tick = fn;
          return () => {
            cancelled = true;
          };
        },
      }),
    ],
    {
      logger: createLogger({}, sink, logDeps),
      logSink: sink,
      logDeps,
      bus: createBus(),
      config: {
        get: <T>(key: string) => (key === "vision.imageDir" ? root : undefined) as T | undefined,
        getAll: () => ({}),
      },
      storageFactory: () => {
        throw new Error("unexpected storage access");
      },
      secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
      permissions: { check: async () => ({ allow: true }) },
      scheduler: { register: () => {}, unregister: () => {} },
      events: { emit: () => {}, on: () => () => {} },
    },
  );
  try {
    const files = createImageFileStore(root);
    const old = await files.saveImageToTmp("old", dataUrl);
    await utimes(join(root, old.slice("/images/".length)), 0, 0);
    await host.activate();
    expect(await readdir(root)).toEqual([]);
    expect(host.getExtensions().some((entry) => entry.id === "vision-handoff")).toBe(true);
    const recent = await files.saveImageToTmp("recent", dataUrl);
    now += 8 * 86_400_000;
    tick();
    const result = await host.unloadExtension("vision-handoff");
    expect(result).toMatchObject({ ok: true });
    expect(result.dangling ?? []).toEqual([]);
    expect(cancelled).toBe(true);
    expect(
      records.filter(
        (record) => record.kind === "log" && record.msg === "vision-handoff: image retention sweep",
      ),
    ).toEqual([
      expect.objectContaining({ level: "info", attributes: { deleted: 1, bytesFreed: 5 } }),
      expect.objectContaining({ level: "info", attributes: { deleted: 1, bytesFreed: 5 } }),
    ]);
    await expect(files.resolveImageUrl(recent)).rejects.toThrow();
  } finally {
    await host.deactivate();
    await rm(dir, { recursive: true, force: true });
  }
});
