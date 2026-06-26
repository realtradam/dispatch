import { describe, expect, it } from "vitest";
import type { Manifest } from "../contracts/extension.js";
import { resolveActivationOrder } from "./dag.js";

function manifest(id: string, deps?: readonly string[]): Manifest {
  const base: Manifest = {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: "^0.1.0",
    trust: "bundled",
  };
  if (deps !== undefined) {
    return { ...base, dependsOn: deps };
  }
  return base;
}

describe("resolveActivationOrder", () => {
  it("returns empty array for no extensions", () => {
    expect(resolveActivationOrder([])).toEqual([]);
  });

  it("returns a single extension with no deps", () => {
    const result = resolveActivationOrder([manifest("a")]);
    expect(result.map((m) => m.id)).toEqual(["a"]);
  });

  it("orders a linear chain (A → B → C)", () => {
    const a = manifest("a");
    const b = manifest("b", ["a"]);
    const c = manifest("c", ["b"]);

    const result = resolveActivationOrder([c, b, a]);
    const ids = result.map((m) => m.id);

    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  it("orders a diamond (A → B, A → C, B → D, C → D)", () => {
    const a = manifest("a");
    const b = manifest("b", ["a"]);
    const c = manifest("c", ["a"]);
    const d = manifest("d", ["b", "c"]);

    const result = resolveActivationOrder([d, c, b, a]);
    const ids = result.map((m) => m.id);

    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
  });

  it("handles independent sets (no deps between them)", () => {
    const a = manifest("a");
    const b = manifest("b");
    const c = manifest("c");

    const result = resolveActivationOrder([a, b, c]);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("throws on a cycle (A → B → A)", () => {
    const a = manifest("a", ["b"]);
    const b = manifest("b", ["a"]);

    expect(() => resolveActivationOrder([a, b])).toThrow(/cycle/i);
  });

  it("throws on a larger cycle (A → B → C → A)", () => {
    const a = manifest("a", ["c"]);
    const b = manifest("b", ["a"]);
    const c = manifest("c", ["b"]);

    expect(() => resolveActivationOrder([a, b, c])).toThrow(/cycle/i);
  });

  it("throws on a missing dependency", () => {
    const a = manifest("a", ["nonexistent"]);

    expect(() => resolveActivationOrder([a])).toThrow(/not available/);
  });

  it("throws on duplicate extension ids", () => {
    const a1 = manifest("a");
    const a2 = manifest("a");

    expect(() => resolveActivationOrder([a1, a2])).toThrow(/duplicate/i);
  });

  it("handles mixed independent and dependent extensions", () => {
    const a = manifest("a");
    const b = manifest("b", ["a"]);
    const c = manifest("c");
    const d = manifest("d", ["c"]);

    const result = resolveActivationOrder([a, b, c, d]);
    const ids = result.map((m) => m.id);

    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
    expect(result).toHaveLength(4);
  });
});
