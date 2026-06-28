/**
 * Conformance test for the wire ABI's type-only surface. The wire package ships
 * no runtime, so these tests assert that the public shapes COMPILE and round-trip
 * — a `Computer` literal satisfies its type, `ComputerEntry` extends `Computer`,
 * and a `Workspace` carries the new `defaultComputerId`. The `ComputerEntry →
 * Computer` assignment is a genuine compile-time check (it would fail to typecheck
 * if the `extends` relationship broke); the runtime assertions are sanity echo.
 */

import { describe, expect, it } from "vitest";
import type { Chunk, Computer, ComputerEntry, ImageChunk, ImageInput, Workspace } from "./index.js";

describe("@dispatch/wire — Computer / Workspace shapes", () => {
  it("a Computer literal satisfies the Computer type", () => {
    const c: Computer = {
      alias: "myserver",
      hostName: "myserver.example.com",
      port: 22,
      user: "deploy",
      identityFile: null,
      knownHost: true,
    };
    expect(c.alias).toBe("myserver");
    expect(c.port).toBe(22);
    expect(c.identityFile).toBeNull();
    expect(c.knownHost).toBe(true);
  });

  it("ComputerEntry extends Computer and carries usageCount", () => {
    const entry: ComputerEntry = {
      alias: "buildbox",
      hostName: "buildbox",
      port: 2222,
      user: "root",
      identityFile: "/home/u/.ssh/id_ed25519",
      knownHost: false,
      usageCount: 3,
    };
    // Compile-time proof that ComputerEntry is assignable to Computer.
    const asComputer: Computer = entry;
    expect(asComputer.alias).toBe("buildbox");
    expect(entry.usageCount).toBe(3);
  });

  it("a Workspace carries defaultComputerId (null = local) and starred", () => {
    const remote: Workspace = {
      id: "default",
      title: "Default",
      defaultCwd: null,
      defaultComputerId: "myserver",
      starred: false,
      createdAt: 0,
      lastActivityAt: 0,
    };
    expect(remote.defaultComputerId).toBe("myserver");
    expect(remote.starred).toBe(false);

    const local: Workspace = { ...remote, defaultComputerId: null };
    expect(local.defaultComputerId).toBeNull();

    const starred: Workspace = { ...remote, starred: true };
    expect(starred.starred).toBe(true);
  });
});

describe("@dispatch/wire — ImageChunk / ImageInput shapes", () => {
  it("an ImageChunk carries a data URL and optional mimeType", () => {
    const c: ImageChunk = {
      type: "image",
      url: "data:image/png;base64,iVBORw0KGgo=",
      mimeType: "image/png",
    };
    expect(c.type).toBe("image");
    expect(c.url).toContain("base64");
    expect(c.mimeType).toBe("image/png");
  });

  it("an ImageChunk with only a url is valid (mimeType optional)", () => {
    const c: ImageChunk = { type: "image", url: "https://example.com/cat.png" };
    expect(c.mimeType).toBeUndefined();
  });

  it("ImageInput mirrors ImageChunk's url semantics", () => {
    const input: ImageInput = { url: "data:image/jpeg;base64,/9j/4AAQ" };
    expect(input.url).toContain("jpeg");
  });

  it("ImageChunk is a member of the Chunk union (assignable)", () => {
    const chunk: Chunk = { type: "image", url: "data:image/png;base64,x" };
    // Compile-time proof: an ImageChunk satisfies the Chunk union.
    expect(chunk.type).toBe("image");
  });
});
