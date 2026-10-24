import { execFileSync } from "node:child_process";
import { mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTextFileFixture } from "./text-file-fixture.js";
import { TEXT_FILE_MAX_BYTES } from "./text-file-logic.js";

type Fixture = Awaited<ReturnType<typeof createTextFileFixture>>;
const fixtures: Fixture[] = [];
async function setup() {
  const fixture = await createTextFileFixture();
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});
function read(fixture: Fixture, path: string, extra: Record<string, string> = {}, id = "local") {
  return fixture.app.request(
    `/conversations/${id}/text-file?${new URLSearchParams({ path, ...extra })}`,
  );
}
async function assertError(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: expect.any(String) });
}

describe("live conversation text-file HTTP routes", () => {
  it("preflights effective inherited context and reads absolute, relative, encoded-literal Markdown as JSON", async () => {
    const f = await setup();
    expect(await (await f.app.request("/conversations/local/text-file-context")).json()).toEqual({
      conversationId: "local",
      cwd: f.root,
      computerId: null,
    });
    for (const path of [f.path, "plan 100%.md", "./plan 100%.md"]) {
      const response = await read(f, path, { expectedCwd: f.root, expectedComputerId: "" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        path: f.path,
        text: f.text,
        format: "markdown",
        bytes: Buffer.byteLength(f.text),
        maxBytes: TEXT_FILE_MAX_BYTES,
      });
    }
    const literal = join(f.root, "literal%20%2F+?#.md");
    await writeFile(literal, "literal filename");
    expect(await (await read(f, literal)).json()).toMatchObject({
      path: literal,
      text: "literal filename",
    });
  });

  it("allows code and extensionless files, Unicode bytes, empty files, and live refresh without mutating history", async () => {
    const f = await setup();
    for (const name of ["code.ts", "document", "empty.txt"]) {
      const path = join(f.root, name);
      const text = name === "empty.txt" ? "" : "<script>alert('x')</script>\n计划😀\n";
      await writeFile(path, text);
      expect(await (await read(f, path)).json()).toMatchObject({
        text,
        format: "text",
        bytes: Buffer.byteLength(text),
      });
    }
    await writeFile(f.path, "updated");
    expect(await (await read(f, f.path)).json()).toMatchObject({ text: "updated" });
    expect(await f.store.load("local")).toEqual([]);
  });

  it("returns 404 for unknown conversations and missing files; rejects malformed query/IDs", async () => {
    const f = await setup();
    await assertError(await read(f, f.path, {}, "unknown"), 404);
    await assertError(await f.app.request("/conversations/unknown/text-file-context"), 404);
    await assertError(await read(f, join(f.root, "missing")), 404);
    for (const query of [
      "",
      "path=a&path=b",
      "path=file%3A%2Ftmp%2Fa",
      "path=~%2Fa",
      "path=a%00b",
      "path=a&expectedCwd=relative",
      "path=a&cwd=/tmp",
    ]) {
      await assertError(await f.app.request(`/conversations/local/text-file?${query}`), 400);
    }
    await assertError(await f.app.request("/conversations/bad%20id/text-file?path=a"), 400);
    await assertError(await f.app.request("/conversations/local/text-file-context?path=a"), 400);
  });

  it("uses conversation cwd overrides and relative cwd only with an absolute workspace base", async () => {
    const f = await setup();
    await mkdir(join(f.root, "sub"));
    await writeFile(join(f.root, "sub", "p.md"), "sub plan");
    await f.store.setCwd("local", "sub");
    expect(
      await (await f.app.request("/conversations/local/text-file-context")).json(),
    ).toMatchObject({ cwd: join(f.root, "sub") });
    expect(
      await (await read(f, "p.md", { expectedCwd: join(f.root, "sub") })).json(),
    ).toMatchObject({ text: "sub plan" });
    await f.store.setWorkspaceDefaultCwd("files", null);
    await assertError(await read(f, f.path), 422);
    await assertError(await f.app.request("/conversations/local/text-file-context"), 422);
    await f.store.setCwd("local", f.root);
    expect((await read(f, "plan 100%.md")).status).toBe(200);
  });

  it("never uses the process cwd: unset context permits absolute files only", async () => {
    const f = await setup();
    await f.store.setWorkspaceDefaultCwd("files", null);
    expect(
      await (await f.app.request("/conversations/local/text-file-context")).json(),
    ).toMatchObject({ cwd: null, computerId: null });
    // This relative path DOES exist from process.cwd(), but is never used there.
    await assertError(
      await read(f, relative(process.cwd(), f.path), { expectedCwd: "", expectedComputerId: "" }),
      400,
    );
    expect((await read(f, f.path, { expectedCwd: "", expectedComputerId: "" })).status).toBe(200);
    await assertError(await read(f, f.path, { expectedCwd: process.cwd() }), 409);
  });

  it("rejects stale context and remote selections even when the exact local path exists", async () => {
    const f = await setup();
    await assertError(
      await read(f, f.path, { expectedCwd: "/stale", expectedComputerId: "" }),
      409,
    );
    await assertError(await read(f, f.path, { expectedComputerId: "other" }), 409);
    await assertError(await read(f, f.path, {}, "remote"), 422);
    await f.store.setWorkspaceDefaultComputerId("files", "workspace-remote");
    expect(
      await (await f.app.request("/conversations/local/text-file-context")).json(),
    ).toMatchObject({ computerId: "workspace-remote" });
    await assertError(await read(f, f.path, { expectedComputerId: "workspace-remote" }), 422);
    await assertError(await read(f, f.path, { expectedComputerId: "" }), 409);
    expect(
      await (await f.app.request("/conversations/remote/text-file-context")).json(),
    ).toMatchObject({ computerId: "remote-test" });
  });

  it("rejects oversize, invalid UTF-8 and binary without truncation; accepts exactly 256 KiB", async () => {
    const f = await setup();
    const path = join(f.root, "bytes");
    for (const bytes of [
      new Uint8Array([255]),
      new Uint8Array([65, 0, 66]),
      new Uint8Array([27]),
      new Uint8Array([194, 133]),
    ]) {
      await writeFile(path, bytes);
      await assertError(await read(f, path), 400);
    }
    await writeFile(path, "a".repeat(TEXT_FILE_MAX_BYTES));
    expect(await (await read(f, path)).json()).toMatchObject({
      bytes: TEXT_FILE_MAX_BYTES,
      text: "a".repeat(TEXT_FILE_MAX_BYTES),
    });
    await truncate(path, TEXT_FILE_MAX_BYTES + 1);
    await assertError(await read(f, path), 413);
  });

  it("rejects directories, symlinks, devices, and a FIFO promptly without opening a blocking read", async () => {
    const f = await setup();
    await assertError(await read(f, f.root), 400);
    const link = join(f.root, "link.md");
    await symlink(f.path, link);
    await assertError(await read(f, link), 400);
    await assertError(await read(f, "/dev/null"), 400);
    const fifo = join(f.root, "fifo");
    execFileSync("mkfifo", [fifo]);
    await assertError(await read(f, fifo), 400);
  }, 2000);

  it("retains trusted Host/Origin guards, including no-store on rejected requests", async () => {
    const f = await setup();
    const url = `/conversations/local/text-file?${new URLSearchParams({ path: f.path })}`;
    for (const headers of [{ host: "attacker.example" }, { origin: "https://attacker.example" }]) {
      const response = await f.app.request(url, { headers: new Headers(Object.entries(headers)) });
      expect([403, 421]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(
      (await f.app.request(url, { headers: { origin: "http://localhost:5173" } })).status,
    ).toBe(200);
  });
});
