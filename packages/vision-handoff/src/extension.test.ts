import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { containedPath, createImageFileStore } from "./extension.js";

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
