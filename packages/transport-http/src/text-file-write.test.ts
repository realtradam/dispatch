import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTextFileFixture } from "./text-file-fixture.js";
import { EXCALIDRAW_MAX_BYTES, TEXT_FILE_MAX_BYTES } from "./text-file-logic.js";

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

function scene(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [],
    appState: {},
    ...overrides,
  });
}

async function put(fixture: Fixture, body: unknown, id = "local"): Promise<Response> {
  const response = await fixture.app.request(`/conversations/${id}/text-file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}

function versionOf(fixture: Fixture, path: string, id = "local"): Promise<Response> {
  return fixture.app.request(
    `/conversations/${id}/text-file-version?${new URLSearchParams({ path })}`,
  );
}

function readFileRoute(fixture: Fixture, path: string, id = "local"): Promise<Response> {
  return fixture.app.request(`/conversations/${id}/text-file?${new URLSearchParams({ path })}`);
}

async function assertError(response: Response, status: number, message?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  if (message === undefined) expect(body).toEqual({ error: expect.any(String) });
  else expect(body).toEqual({ error: message });
}

async function tempLeftovers(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.includes(".dispatch-tmp"));
}

describe("PUT /conversations/:id/text-file", () => {
  it("atomically replaces an Excalidraw scene, preserving versions and permission bits", async () => {
    const f = await setup();
    const path = join(f.root, "board.excalidraw");
    await writeFile(path, scene());
    await chmod(path, 0o640);
    const read = await (await readFileRoute(f, path)).json();
    expect(read.maxBytes).toBe(EXCALIDRAW_MAX_BYTES);

    const text = scene({ elements: [{ id: "rect-1", type: "rectangle" }] });
    const response = await put(f, { path, text, expectedVersion: read.version });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      path,
      version: expect.any(String),
      bytes: Buffer.byteLength(text),
      maxBytes: EXCALIDRAW_MAX_BYTES,
    });
    expect(body.version).not.toBe(read.version);
    expect(await readFile(path, "utf8")).toBe(text);
    expect((await stat(path)).mode & 0o777).toBe(0o640);

    // The returned version is the live file's version: no self-inflicted reload loop.
    const polled = await (await versionOf(f, path)).json();
    expect(polled).toEqual({ path, version: body.version });
    expect(await tempLeftovers(f.root)).toEqual([]);
  });

  it("returns 412 and writes nothing when expectedVersion is stale", async () => {
    const f = await setup();
    const path = join(f.root, "board.excalidraw");
    const original = scene({ elements: [] });
    await writeFile(path, original);
    const current = (await (await versionOf(f, path)).json()).version;
    const response = await put(f, {
      path,
      text: scene({ elements: [{ id: "new" }] }),
      expectedVersion: "stale-version",
    });
    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({
      error: "Text file changed since it was loaded",
      version: current,
    });
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await tempLeftovers(f.root)).toEqual([]);
  });

  it("refuses non-Excalidraw paths with 403 and leaves the file unchanged", async () => {
    const f = await setup();
    const path = join(f.root, "notes.md");
    await writeFile(path, "# notes");
    const version = (await (await versionOf(f, path)).json()).version;
    await assertError(
      await put(f, { path, text: scene(), expectedVersion: version }),
      403,
      "Only .excalidraw files are writable",
    );
    expect(await readFile(path, "utf8")).toBe("# notes");
  });

  it("returns 404 for a missing Excalidraw file and creates nothing", async () => {
    const f = await setup();
    const path = join(f.root, "absent.excalidraw");
    await assertError(await put(f, { path, text: scene(), expectedVersion: "x" }), 404);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await tempLeftovers(f.root)).toEqual([]);
  });

  it("rejects a final-component symlink with 400", async () => {
    const f = await setup();
    const target = join(f.root, "target.excalidraw");
    await writeFile(target, scene());
    const link = join(f.root, "link.excalidraw");
    await symlink(target, link);
    const version = (await (await versionOf(f, target)).json()).version;
    await assertError(await put(f, { path: link, text: scene(), expectedVersion: version }), 400);
    expect(await readFile(target, "utf8")).toBe(scene());
  });

  it("rejects invalid scene text with 400 and leaves the file unchanged", async () => {
    const f = await setup();
    const path = join(f.root, "board.excalidraw");
    const original = scene();
    await writeFile(path, original);
    const version = (await (await versionOf(f, path)).json()).version;
    for (const text of ["not json", "[]", JSON.stringify({ type: "other", elements: [] })]) {
      await assertError(
        await put(f, { path, text, expectedVersion: version }),
        400,
        "Text is not a valid Excalidraw scene",
      );
      expect(await readFile(path, "utf8")).toBe(original);
    }
    expect(await tempLeftovers(f.root)).toEqual([]);
  });

  it("enforces context guards, remote refusal, unknown conversations and malformed bodies", async () => {
    const f = await setup();
    const path = join(f.root, "board.excalidraw");
    await writeFile(path, scene());
    const version = (await (await versionOf(f, path)).json()).version;
    await assertError(
      await put(f, { path, text: scene(), expectedVersion: version, expectedCwd: "/wrong" }),
      409,
    );
    await assertError(
      await put(
        f,
        { path, text: scene(), expectedVersion: version, expectedComputerId: "remote-test" },
        "remote",
      ),
      422,
    );
    await assertError(
      await put(f, { path, text: scene(), expectedVersion: version }, "unknown"),
      404,
    );
    await assertError(await put(f, "{not json"), 400, "Text-file write body must be a JSON object");
    await assertError(
      await put(f, { path, text: scene(), expectedVersion: version, extra: true }),
      400,
      "Unexpected text-file write field",
    );
    expect(await readFile(path, "utf8")).toBe(scene());
  });

  it("resolves a relative path against the conversation cwd", async () => {
    const f = await setup();
    await mkdir(join(f.root, "sub"));
    const path = join(f.root, "sub", "board.excalidraw");
    await writeFile(path, scene());
    await f.store.setCwd("local", "sub");
    const version = (await (await versionOf(f, path)).json()).version;
    const text = scene({ elements: [{ id: "relative" }] });
    const response = await put(f, {
      path: "board.excalidraw",
      text,
      expectedVersion: version,
      expectedCwd: join(f.root, "sub"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path });
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("reads and polls an Excalidraw file between 256 KiB and 16 MiB without truncation", async () => {
    const f = await setup();
    const big = scene({ elements: [], appState: { pad: "a".repeat(TEXT_FILE_MAX_BYTES + 1024) } });
    const path = join(f.root, "big.excalidraw");
    await writeFile(path, big);
    const read = await readFileRoute(f, path);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      text: big,
      bytes: Buffer.byteLength(big),
      maxBytes: EXCALIDRAW_MAX_BYTES,
    });
    expect((await versionOf(f, path)).status).toBe(200);

    // The same size for a non-Excalidraw path still hits the 256 KiB cap.
    const textPath = join(f.root, "big.txt");
    await writeFile(textPath, big);
    await assertError(
      await readFileRoute(f, textPath),
      413,
      "Text file exceeds the 256 KiB size limit",
    );
    await assertError(
      await versionOf(f, textPath),
      413,
      "Text file exceeds the 256 KiB size limit",
    );
  });
});
