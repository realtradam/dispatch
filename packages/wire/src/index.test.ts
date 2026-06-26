/**
 * Conformance test for the wire ABI's type-only surface. The wire package ships
 * no runtime, so these tests assert that the public shapes COMPILE and round-trip
 * — a `Computer` literal satisfies its type, `ComputerEntry` extends `Computer`,
 * and a `Workspace` carries the new `defaultComputerId`. The `ComputerEntry →
 * Computer` assignment is a genuine compile-time check (it would fail to typecheck
 * if the `extends` relationship broke); the runtime assertions are sanity echo.
 */

import { describe, expect, it } from "vitest";
import type { Computer, ComputerEntry, Workspace } from "./index.js";

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

  it("a Workspace carries defaultComputerId (null = local)", () => {
    const remote: Workspace = {
      id: "default",
      title: "Default",
      defaultCwd: null,
      defaultComputerId: "myserver",
      createdAt: 0,
      lastActivityAt: 0,
    };
    expect(remote.defaultComputerId).toBe("myserver");

    const local: Workspace = { ...remote, defaultComputerId: null };
    expect(local.defaultComputerId).toBeNull();
  });
});
