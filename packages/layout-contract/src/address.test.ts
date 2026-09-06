import { describe, expect, it } from "vitest";
import { findById, isDescendantOrSelf, parentPath, resolveRef } from "./address";
import { DEFAULT_LAYOUT } from "./default-layout";
import type { LayoutTree, LeafNode, PanelsNode, SplitNode } from "./tree";

describe("findById", () => {
  it("finds nodes in the default tree with their paths", () => {
    const root = findById(DEFAULT_LAYOUT, "root");
    expect(root?.path).toEqual([]);
    const main = findById(DEFAULT_LAYOUT, "main");
    expect(main?.path).toEqual([0]);
    const side = findById(DEFAULT_LAYOUT, "side");
    expect(side?.path).toEqual([1]);
  });

  it("returns null for unknown ids", () => {
    expect(findById(DEFAULT_LAYOUT, "nope")).toBeNull();
  });

  it("finds the titlebar when set", () => {
    const tree: LayoutTree = {
      version: 1,
      titlebar: { kind: "leaf", id: "brand", view: "titlebar" },
      root: { kind: "leaf", view: "chat" },
    };
    expect(findById(tree, "brand")?.path).toEqual(["titlebar"]);
  });
});

describe("resolveRef", () => {
  it("resolves the root via an empty path", () => {
    const result = resolveRef(DEFAULT_LAYOUT, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value.node as SplitNode).id).toBe("root");
      expect(result.value.path).toEqual([]);
    }
  });

  it("resolves by path, indexing panels like split/stack children", () => {
    const tabs = resolveRef(DEFAULT_LAYOUT, [1, 0]);
    expect(tabs.ok).toBe(true);
    if (tabs.ok) expect((tabs.value.node as LeafNode).view).toBe("tabs");
  });

  it("resolves by id", () => {
    const result = resolveRef(DEFAULT_LAYOUT, "side");
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value.node as PanelsNode).panels).toHaveLength(2);
  });

  it("addresses the titlebar slot and its descendants", () => {
    const tree: LayoutTree = {
      version: 1,
      titlebar: {
        kind: "stack",
        id: "tb",
        children: [{ node: { kind: "leaf", view: "brand" }, grow: 1 }],
      },
      root: { kind: "leaf", view: "chat" },
    };
    expect(resolveRef(tree, ["titlebar"]).ok).toBe(true);
    const child = resolveRef(tree, ["titlebar", 0]);
    expect(child.ok).toBe(true);
    if (child.ok) expect((child.value.node as LeafNode).view).toBe("brand");
  });

  it("fails loudly on bad paths and unknown ids", () => {
    const noTitlebar = resolveRef(DEFAULT_LAYOUT, ["titlebar"]);
    expect(noTitlebar.ok).toBe(false);
    if (!noTitlebar.ok) expect(noTitlebar.error).toContain("titlebar");

    const outOfRange = resolveRef(DEFAULT_LAYOUT, [1, 9]);
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.error).toContain("out of range");

    const unknown = resolveRef(DEFAULT_LAYOUT, "ghost");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("ghost");
  });
});

describe("path helpers", () => {
  it("parentPath returns the container's path", () => {
    expect(parentPath([])).toEqual([]);
    expect(parentPath([0, 1, 2])).toEqual([0, 1]);
    expect(parentPath(["titlebar", 0])).toEqual(["titlebar"]);
  });

  it("isDescendantOrSelf detects subtree membership", () => {
    expect(isDescendantOrSelf([0, 1, 2], [0, 1])).toBe(true);
    expect(isDescendantOrSelf([0, 1], [0, 1])).toBe(true);
    expect(isDescendantOrSelf([0, 9], [0, 1])).toBe(false);
    expect(isDescendantOrSelf([1], [0, 1])).toBe(false);
  });
});
