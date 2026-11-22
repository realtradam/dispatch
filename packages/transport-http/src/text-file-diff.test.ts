import { execFileSync } from "node:child_process";
import { mkdir, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TextFileDiffResponse,
  TextFileDiffVersionResponse,
} from "@dispatch/transport-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createTextFileFixture } from "./text-file-fixture.js";
import { runGit } from "./text-file-git.js";
import { TEXT_FILE_MAX_BYTES } from "./text-file-logic.js";

type Fixture = Awaited<ReturnType<typeof createTextFileFixture>>;
const fixtures: Fixture[] = [];
async function setup(options: { readonly commit?: boolean } = {}) {
  const fixture = await createTextFileFixture();
  fixtures.push(fixture);
  git(fixture, "init", "-q", "-b", "main");
  if (options.commit !== false) commitAll(fixture);
  return fixture;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

function git(fixture: Fixture, ...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"] },
  ).toString();
}
function commitAll(fixture: Fixture) {
  git(fixture, "add", "-A");
  git(fixture, "commit", "-q", "--allow-empty", "-m", "commit");
}
function query(path: string, extra: Record<string, string>) {
  return new URLSearchParams({ path, ...extra }).toString();
}
async function diff(
  fixture: Fixture,
  path: string,
  extra: Record<string, string> = {},
  id = "local",
): Promise<Response> {
  const response = await fixture.app.request(
    `/conversations/${id}/text-file-diff?${query(path, extra)}`,
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}
async function diffVersion(
  fixture: Fixture,
  path: string,
  extra: Record<string, string> = {},
  id = "local",
): Promise<Response> {
  const response = await fixture.app.request(
    `/conversations/${id}/text-file-diff-version?${query(path, extra)}`,
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}
async function ok(fixture: Fixture, path: string): Promise<TextFileDiffResponse> {
  const response = await diff(fixture, path);
  expect(response.status).toBe(200);
  const body = (await response.json()) as TextFileDiffResponse;
  const version = await diffVersion(fixture, path);
  expect(version.status).toBe(200);
  // Unchanged state: the cheap poll agrees with the diff it would trigger.
  expect((await version.json()) as TextFileDiffVersionResponse).toEqual({
    path: body.path,
    version: body.version,
  });
  return body;
}
async function expectError(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: expect.any(String) });
}
const kinds = (body: TextFileDiffResponse) =>
  body.lines.map(
    (line) => `${line.kind[0]}${line.oldLine ?? "-"}:${line.newLine ?? "-"} ${line.text}`,
  );

describe("uncommitted git diff routes", () => {
  it("shows a committed file as unmodified, then live-diffs edits against HEAD", async () => {
    const f = await setup();
    await writeFile(f.path, "one\ntwo\nthree\n");
    commitAll(f);
    const clean = await ok(f, f.path);
    expect(clean).toMatchObject({
      path: f.path,
      repoRoot: expect.any(String),
      status: "unmodified",
      added: 0,
      removed: 0,
      format: "markdown",
      maxBytes: TEXT_FILE_MAX_BYTES,
    });
    expect(kinds(clean)).toEqual(["c1:1 one", "c2:2 two", "c3:3 three"]);
    expect((await ok(f, "plan 100%.md")).version).toBe(clean.version);

    await writeFile(f.path, "one\nTWO\nthree\nfour\n");
    await utimes(f.path, 1000000001, 1000000001);
    const polled = (await (await diffVersion(f, f.path)).json()) as TextFileDiffVersionResponse;
    expect(polled.version).not.toBe(clean.version);
    const edited = await ok(f, f.path);
    expect(edited).toMatchObject({ status: "modified", added: 2, removed: 1 });
    expect(kinds(edited)).toEqual(["c1:1 one", "r2:- two", "a-:2 TWO", "c3:3 three", "a-:4 four"]);

    commitAll(f);
    const committed = await ok(f, f.path);
    expect(committed.status).toBe("unmodified");
    expect(committed.version).not.toBe(edited.version);
  });

  it("diffs a file whose content looks like diff syntax, CRLF and no final newline", async () => {
    const f = await setup();
    const path = join(f.root, "tricky.txt");
    await writeFile(path, "--- a\n+++ b\n@@ -1 +1 @@\nend");
    commitAll(f);
    await writeFile(path, "--- a\n+++ c\r\n@@ -1 +1 @@\n\nend\n");
    const body = await ok(f, path);
    expect(body.status).toBe("modified");
    expect(kinds(body)).toEqual([
      "c1:1 --- a",
      "r2:- +++ b",
      "a-:2 +++ c\r",
      "c3:3 @@ -1 +1 @@",
      "r4:- end",
      "a-:4 ",
      "a-:5 end",
    ]);
  });

  it("classifies untracked, staged, ignored, glob-named and nested files", async () => {
    const f = await setup();
    await mkdir(join(f.root, "sub", "deep"), { recursive: true });
    const untracked = join(f.root, "sub", "deep", "new*.txt");
    await writeFile(untracked, "a\nb\n");
    await writeFile(join(f.root, "sub", "deep", "newer.txt"), "glob sibling\n");
    const untrackedBody = await ok(f, "sub/deep/new*.txt");
    expect(untrackedBody).toMatchObject({ path: untracked, status: "untracked", added: 2 });
    expect(kinds(untrackedBody)).toEqual(["a-:1 a", "a-:2 b"]);

    git(f, "add", "--", "sub/deep/new*.txt");
    const staged = await ok(f, untracked);
    expect(staged).toMatchObject({ status: "added", added: 2, removed: 0 });
    expect(staged.version).not.toBe(untrackedBody.version);

    await writeFile(join(f.root, ".gitignore"), "build/\n*.log\n");
    await mkdir(join(f.root, "build"));
    await writeFile(join(f.root, "build", "out.txt"), "x\n");
    await writeFile(join(f.root, "app.log"), "y\n");
    for (const path of ["build/out.txt", "app.log"]) {
      const ignored = await ok(f, path);
      expect(ignored).toMatchObject({ status: "ignored", added: 0, removed: 0 });
      expect(ignored.lines).toHaveLength(1);
    }
  });

  it("keeps showing a deleted file as removed lines, even when its directory is gone", async () => {
    const f = await setup();
    await mkdir(join(f.root, "gone"));
    const path = join(f.root, "gone", "file.txt");
    await writeFile(path, "keep\nme");
    commitAll(f);
    await rm(join(f.root, "gone"), { recursive: true });
    expect(
      (await f.app.request(`/conversations/local/text-file-version?${query(path, {})}`)).status,
    ).toBe(404);
    const body = await ok(f, path);
    expect(body).toMatchObject({ status: "deleted", added: 0, removed: 2 });
    expect(kinds(body)).toEqual(["r1:- keep", "r2:- me"]);
  });

  it("reports a staged-then-reverted file as unmodified", async () => {
    const f = await setup();
    await writeFile(f.path, "same\n");
    commitAll(f);
    await writeFile(f.path, "staged\n");
    git(f, "add", "-A");
    await writeFile(f.path, "same\n");
    const body = await ok(f, f.path);
    expect(body).toMatchObject({ status: "unmodified", added: 0, removed: 0 });
    expect(kinds(body)).toEqual(["c1:1 same"]);
  });

  it("treats every file of a branch without commits as added", async () => {
    const f = await setup({ commit: false });
    expect(await ok(f, f.path)).toMatchObject({ status: "untracked", removed: 0 });
    git(f, "add", "-A");
    const staged = await ok(f, f.path);
    expect(staged.status).toBe("added");
    expect(staged.added).toBe(staged.lines.length);
  });

  it("reads files outside a git work tree as context", async () => {
    const f = await createTextFileFixture();
    fixtures.push(f);
    const body = await ok(f, f.path);
    expect(body).toMatchObject({ status: "not-in-repo", repoRoot: null, added: 0, removed: 0 });
    expect(body.lines.every((line) => line.kind === "context")).toBe(true);
    await expectError(await diff(f, join(f.root, "missing.txt")), 404);
    await expectError(await diffVersion(f, join(f.root, "missing.txt")), 404);
  });

  it("rejects binary diffs, oversized files and the text-file error cases", async () => {
    const f = await setup();
    const binary = join(f.root, "data.bin");
    await writeFile(binary, new Uint8Array([1, 0, 2]));
    commitAll(f);
    await writeFile(binary, new Uint8Array([1, 0, 3]));
    await expectError(await diff(f, binary), 400);
    expect((await diffVersion(f, binary)).status).toBe(200);

    const large = join(f.root, "large.txt");
    await writeFile(large, "");
    await truncate(large, TEXT_FILE_MAX_BYTES + 1);
    await expectError(await diff(f, large), 413);
    await expectError(await diffVersion(f, large), 413);

    const shrinking = join(f.root, "shrinking.txt");
    await writeFile(shrinking, `${"x".repeat(99)}\n`.repeat(TEXT_FILE_MAX_BYTES / 100 + 10));
    commitAll(f);
    await writeFile(shrinking, "small\n");
    await expectError(await diff(f, shrinking), 413);

    const link = join(f.root, "link.md");
    await symlink(f.path, link);
    await expectError(await diff(f, link), 400);
    await expectError(await diff(f, f.root), 400);
    await expectError(await diff(f, join(f.root, "never.txt")), 404);
    await expectError(await diff(f, f.path, {}, "unknown"), 404);
    await expectError(await diffVersion(f, f.path, {}, "unknown"), 404);
    await expectError(await diff(f, f.path, {}, "remote"), 422);
    await expectError(await diff(f, f.path, { expectedCwd: "/wrong" }), 409);
    await expectError(await diffVersion(f, f.path, { expectedComputerId: "x" }), 409);
    await expectError(await diff(f, f.path, { unexpected: "x" }), 400);
    expect((await diff(f, f.path, { expectedCwd: f.root, expectedComputerId: "" })).status).toBe(
      200,
    );
  });
});

describe("runGit", () => {
  it("bounds stdout, reports exit codes and spawn failures", async () => {
    const f = await createTextFileFixture();
    fixtures.push(f);
    const version = await runGit(["--version"], { cwd: f.root, maxStdoutBytes: 1000 });
    expect(version).toMatchObject({ exitCode: 0 });
    expect(await runGit(["--version"], { cwd: f.root, maxStdoutBytes: 3 })).toEqual({
      failure: "overflow",
    });
    expect(
      await runGit(["rev-parse", "--show-toplevel"], { cwd: f.root, maxStdoutBytes: 100 }),
    ).toMatchObject({ exitCode: 128 });
    expect(
      await runGit(["--version"], { cwd: join(f.root, "missing"), maxStdoutBytes: 100 }),
    ).toEqual({ failure: "spawn" });
  });

  it("kills a git command that outlives its timeout", async () => {
    const f = await createTextFileFixture();
    fixtures.push(f);
    // A shell alias that sleeps far past the timeout.
    const result = await runGit(["-c", "alias.hang=!sleep 5", "hang"], {
      cwd: f.root,
      maxStdoutBytes: 100,
      timeoutMs: 50,
    });
    expect(result).toEqual({ failure: "timeout" });
  });
});
