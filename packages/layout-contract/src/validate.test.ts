import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT } from "./default-layout";
import type { LayoutNode, LayoutTree, LeafNode } from "./tree";
import { validateTree } from "./validate";

function treeOf(root: LayoutNode): LayoutTree {
  return { version: 1, root };
}

function leafOf(view: string): LeafNode {
  return { kind: "leaf", view };
}

describe("validateTree", () => {
  it("accepts the default tree", () => {
    expect(validateTree(DEFAULT_LAYOUT)).toEqual({ ok: true });
  });

  it("accepts a simple valid tree", () => {
    const tree = treeOf({
      kind: "split",
      dir: "row",
      children: [
        { size: 1, node: { kind: "stack", children: [{ grow: 1, node: leafOf("chat") }] } },
        {
          size: 0,
          basis: 320,
          collapsible: true,
          node: { kind: "panels", panels: [leafOf("tabs")] },
        },
      ],
    });
    expect(validateTree(tree)).toEqual({ ok: true });
  });

  it("rejects empty containers (split / stack / panels)", () => {
    const split: LayoutTree = treeOf({ kind: "split", dir: "row", children: [] });
    const stack: LayoutTree = treeOf({ kind: "stack", children: [] });
    const panels: LayoutTree = treeOf({ kind: "panels", panels: [] });
    for (const tree of [split, stack, panels]) {
      const result = validateTree(tree);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]).toMatch(/no children|no panels/);
    }
  });

  it("rejects a zero-size child without a basis", () => {
    const tree = treeOf({
      kind: "split",
      dir: "row",
      children: [{ size: 0, node: leafOf("a") }],
    });
    const result = validateTree(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("basis");
  });

  it("rejects negative/non-finite sizes and non-positive basis", () => {
    const base = (size: number, basis?: number): LayoutTree =>
      treeOf({ kind: "split", dir: "row", children: [{ size, basis, node: leafOf("a") }] });
    expect(validateTree(base(-1)).ok).toBe(false);
    expect(validateTree(base(Number.NaN)).ok).toBe(false);
    expect(validateTree(base(0, 0)).ok).toBe(false);
    expect(validateTree(base(0, -5)).ok).toBe(false);
    expect(validateTree(base(1, 100)).ok).toBe(true);
  });

  it("rejects duplicate node ids across the tree (and accepts unique ones)", () => {
    const dup: LayoutTree = treeOf({
      kind: "split",
      id: "root",
      dir: "row",
      children: [
        {
          size: 1,
          node: { kind: "stack", id: "same", children: [{ grow: 1, node: leafOf("a") }] },
        },
        {
          size: 1,
          node: { kind: "stack", id: "same", children: [{ grow: 1, node: leafOf("b") }] },
        },
      ],
    });
    const result = validateTree(dup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('duplicate node id "same"');

    const unique: LayoutTree = treeOf({
      kind: "split",
      id: "root",
      dir: "row",
      children: [
        { size: 1, node: { kind: "stack", id: "a", children: [{ grow: 1, node: leafOf("x") }] } },
        { size: 1, node: { kind: "stack", id: "b", children: [{ grow: 1, node: leafOf("y") }] } },
      ],
    });
    expect(validateTree(unique).ok).toBe(true);
  });

  it("rejects an empty leaf view", () => {
    const tree = treeOf(leafOf(""));
    const result = validateTree(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("non-empty");
  });

  it("checks leaves against a known-view set when given", () => {
    const tree = treeOf(leafOf("chat"));
    expect(validateTree(tree, ["chat"]).ok).toBe(true);
    const result = validateTree(tree, ["tabs"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('unknown view "chat"');
  });

  it("validates the titlebar slot when set", () => {
    const tree: LayoutTree = { version: 1, titlebar: leafOf(""), root: leafOf("chat") };
    const result = validateTree(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("titlebar");
  });

  it("reports every problem at once", () => {
    const tree = treeOf({
      kind: "split",
      dir: "row",
      children: [
        { size: 0, node: leafOf("") },
        { size: 1, node: { kind: "stack", id: "x", children: [{ grow: -2, node: leafOf("b") }] } },
      ],
    });
    const result = validateTree(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
