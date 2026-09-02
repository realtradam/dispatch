import { describe, expect, it } from "vitest";
import type { Manifest } from "../contracts/extension.js";
import { resolveActivationOrder, resolveActivationOrderSafe } from "./dag.js";

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

describe("resolveActivationOrderSafe (non-throwing)", () => {
  it("returns empty resolution for no extensions", () => {
    const result = resolveActivationOrderSafe([]);
    expect(result.ordered).toEqual([]);
    expect(result.unmet).toEqual([]);
  });

  it("resolves a linear chain in dependency order without throwing", () => {
    const a = manifest("a");
    const b = manifest("b", ["a"]);
    const c = manifest("c", ["b"]);

    const result = resolveActivationOrderSafe([c, b, a]);
    expect(result.ordered.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(result.unmet).toEqual([]);
  });

  it("reports an unmet dependency instead of throwing", () => {
    const a = manifest("a", ["nonexistent"]);

    const result = resolveActivationOrderSafe([a]);
    expect(result.ordered).toEqual([]);
    expect(result.unmet).toHaveLength(1);
    expect(result.unmet[0]?.manifest.id).toBe("a");
    expect(result.unmet[0]?.missing).toEqual(["nonexistent"]);
  });

  it("treats deps listed in `satisfied` as available (runtime loaded set)", () => {
    const a = manifest("a", ["loaded-dep", "missing-dep"]);

    const result = resolveActivationOrderSafe([a], { satisfied: ["loaded-dep"] });
    // `loaded-dep` is satisfied, but `missing-dep` is not — a stays unmet
    // and only the genuinely-missing dep is reported.
    expect(result.ordered).toEqual([]);
    expect(result.unmet).toHaveLength(1);
    expect(result.unmet[0]?.missing).toEqual(["missing-dep"]);
  });

  it("resolves a manifest whose deps are all satisfied externally", () => {
    const a = manifest("a", ["loaded-dep"]);

    const result = resolveActivationOrderSafe([a], { satisfied: ["loaded-dep"] });
    expect(result.ordered.map((m) => m.id)).toEqual(["a"]);
    expect(result.unmet).toEqual([]);
  });

  it("still resolves when deps are provided by other manifests in the set", () => {
    const a = manifest("a");
    const b = manifest("b", ["a"]);

    const result = resolveActivationOrderSafe([b, a]);
    expect(result.ordered.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.unmet).toEqual([]);
  });

  it("reports cycle members as unmet with their in-cycle deps (no throw)", () => {
    const a = manifest("a", ["b"]);
    const b = manifest("b", ["a"]);

    const result = resolveActivationOrderSafe([a, b]);
    expect(result.ordered).toEqual([]);
    expect(result.unmet).toHaveLength(2);
    const unmetById = new Map(result.unmet.map((u) => [u.manifest.id, u.missing]));
    expect(unmetById.get("a")).toEqual(["b"]);
    expect(unmetById.get("b")).toEqual(["a"]);
  });

  it("resolves the resolvable subset and reports only the broken part", () => {
    const a = manifest("a");
    const bad = manifest("bad", ["ghost"]);

    const result = resolveActivationOrderSafe([bad, a]);
    expect(result.ordered.map((m) => m.id)).toEqual(["a"]);
    expect(result.unmet).toHaveLength(1);
    expect(result.unmet[0]?.manifest.id).toBe("bad");
  });

  it("reports transitively-blocked dependents as unmet", () => {
    // c depends on b which depends on a missing dep — both must be unmet.
    const b = manifest("b", ["ghost"]);
    const c = manifest("c", ["b"]);

    const result = resolveActivationOrderSafe([c, b]);
    expect(result.ordered).toEqual([]);
    expect(result.unmet.map((u) => u.manifest.id).sort()).toEqual(["b", "c"]);
    const unmetById = new Map(result.unmet.map((u) => [u.manifest.id, u.missing]));
    expect(unmetById.get("b")).toEqual(["ghost"]);
    expect(unmetById.get("c")).toEqual(["b"]);
  });

  it("tolerates duplicate ids (first occurrence wins, no throw)", () => {
    const a1 = manifest("a");
    const a2 = manifest("a");

    const result = resolveActivationOrderSafe([a1, a2]);
    expect(result.ordered.map((m) => m.id)).toEqual(["a"]);
    expect(result.unmet).toEqual([]);
  });

  it("keeps the throwing boot variant intact (missing dep still throws there)", () => {
    const a = manifest("a", ["nonexistent"]);
    expect(() => resolveActivationOrder([a])).toThrow(/not available/);
  });
});
