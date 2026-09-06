import { describe, expect, it } from "vitest";
import type { Manifest, PluginTier } from "../contracts/extension.js";
import { assertNoCoreToStandardDeps, findCoreToStandardDeps } from "./tiers.js";

function manifest(id: string, tier: PluginTier, deps?: readonly string[]): Manifest {
  const base: Manifest = {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: "^0.1.0",
    tier,
    trust: "bundled",
  };
  if (deps !== undefined) {
    return { ...base, dependsOn: deps };
  }
  return base;
}

describe("findCoreToStandardDeps", () => {
  it("flags a core→standard edge", () => {
    const violations = findCoreToStandardDeps([
      manifest("core-ext", "core", ["std-ext"]),
      manifest("std-ext", "standard"),
    ]);
    expect(violations).toEqual([{ id: "core-ext", depId: "std-ext" }]);
  });

  it("flags every violating edge of a core extension, in dependsOn order", () => {
    const violations = findCoreToStandardDeps([
      manifest("core-ext", "core", ["std-a", "other-core", "std-b"]),
      manifest("std-a", "standard"),
      manifest("std-b", "standard"),
      manifest("other-core", "core"),
    ]);
    expect(violations).toEqual([
      { id: "core-ext", depId: "std-a" },
      { id: "core-ext", depId: "std-b" },
    ]);
  });

  it("does not flag core→core edges", () => {
    const violations = findCoreToStandardDeps([
      manifest("core-a", "core", ["core-b"]),
      manifest("core-b", "core"),
    ]);
    expect(violations).toEqual([]);
  });

  it("does not flag core→providers edges (out of scope — the rule is core→standard)", () => {
    const violations = findCoreToStandardDeps([
      manifest("core-ext", "core", ["provider-ext"]),
      manifest("provider-ext", "providers"),
    ]);
    expect(violations).toEqual([]);
  });

  it("does not flag standard→core or standard→standard edges", () => {
    const violations = findCoreToStandardDeps([
      manifest("std-a", "standard", ["core-ext", "std-b"]),
      manifest("std-b", "standard"),
      manifest("core-ext", "core"),
    ]);
    expect(violations).toEqual([]);
  });

  it("ignores dep ids not present in the manifest set (unmet deps are the DAG's job)", () => {
    const violations = findCoreToStandardDeps([manifest("core-ext", "core", ["not-bundled"])]);
    expect(violations).toEqual([]);
  });

  it("returns empty for extensions with no dependsOn", () => {
    const violations = findCoreToStandardDeps([
      manifest("core-ext", "core"),
      manifest("std-ext", "standard"),
    ]);
    expect(violations).toEqual([]);
  });
});

describe("assertNoCoreToStandardDeps", () => {
  it("passes on a clean set", () => {
    expect(() =>
      assertNoCoreToStandardDeps([
        manifest("core-ext", "core", ["other-core"]),
        manifest("other-core", "core"),
        manifest("std-ext", "standard", ["core-ext"]),
      ]),
    ).not.toThrow();
  });

  it("throws naming both endpoints of every violating edge", () => {
    expect(() =>
      assertNoCoreToStandardDeps([
        manifest("core-ext", "core", ["std-ext"]),
        manifest("std-ext", "standard"),
      ]),
    ).toThrow(/core-ext.*std-ext/);
    // And the message states the rule.
    expect(() =>
      assertNoCoreToStandardDeps([
        manifest("core-ext", "core", ["std-ext"]),
        manifest("std-ext", "standard"),
      ]),
    ).toThrow(/Core depends only on core/);
  });
});
