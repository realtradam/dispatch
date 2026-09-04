import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT } from "./default-layout";
import {
  applyOp,
  applyOps,
  ensureLeaf,
  ensurePanel,
  insertLeaf,
  insertPanel,
  moveNode,
  removeNode,
  replaceView,
  setSizes,
  splitLeaf,
} from "./ops";
import type { LayoutNode, LayoutTree, LeafNode, PanelsNode, SplitNode, StackNode } from "./tree";
import { validateTree } from "./validate";

/** A minimal valid tree: split row of two stacks holding leaves. */
function treeOf(root: LayoutNode): LayoutTree {
  return { version: 1, root };
}

function splitOf(...children: SplitNode["children"]): SplitNode {
  return { kind: "split", dir: "row", children };
}

function stackOf(...children: StackNode["children"]): StackNode {
  return { kind: "stack", children };
}

function panelsOf(...views: string[]): PanelsNode {
  return { kind: "panels", panels: views.map((view) => ({ kind: "leaf", view })) };
}

function leafOf(view: string, id?: string): LeafNode {
  return id === undefined ? { kind: "leaf", view } : { kind: "leaf", id, view };
}

/** The default tree's shape, shortened: split[stack[chat, queue, composer], panels[tabs, model]]. */
function defaultTree(): LayoutTree {
  return structuredClone(DEFAULT_LAYOUT);
}

function viewsOfPanels(node: PanelsNode): string[] {
  return node.panels.map((p) => p.view);
}

describe("replaceView", () => {
  it("replaces the view of a leaf addressed by path", () => {
    const tree = treeOf(stackOf({ node: leafOf("chat"), grow: 1 }, { node: leafOf("composer") }));
    const result = replaceView(tree, [0], "tasks");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stack = result.tree.root as StackNode;
    expect((stack.children[0]?.node as LeafNode).view).toBe("tasks");
    // Immutability: the input tree is untouched.
    expect(((tree.root as StackNode).children[0]?.node as LeafNode).view).toBe("chat");
  });

  it("replaces a leaf addressed by id", () => {
    const tree = treeOf(stackOf({ node: leafOf("chat", "chat-leaf"), grow: 1 }));
    const result = replaceView(tree, "chat-leaf", "tasks");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(((result.tree.root as StackNode).children[0]?.node as LeafNode).view).toBe("tasks");
  });

  it("fails on a non-leaf target", () => {
    const tree = treeOf(splitOf({ node: stackOf({ node: leafOf("a") }), size: 1 }));
    const result = replaceView(tree, [0], "b");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not a leaf");
  });

  it("fails on a bad path / unknown id", () => {
    const tree = treeOf(stackOf({ node: leafOf("a") }));
    expect(replaceView(tree, [7], "b").ok).toBe(false);
    expect(replaceView(tree, "nope", "b").ok).toBe(false);
  });
});

describe("insertLeaf / insertPanel", () => {
  it("appends to a split with size 1 by default", () => {
    const tree = treeOf(splitOf({ node: leafOf("a"), size: 1 }));
    const result = insertLeaf(tree, [], "b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const split = result.tree.root as SplitNode;
    expect(split.children).toHaveLength(2);
    expect(split.children[1]?.size).toBe(1);
    expect(validateTree(result.tree).ok).toBe(true);
  });

  it("inserts at an explicit index with an explicit size", () => {
    const tree = treeOf(splitOf({ node: leafOf("a"), size: 1 }, { node: leafOf("b"), size: 2 }));
    const result = insertLeaf(tree, [], "c", { index: 1, size: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const split = result.tree.root as SplitNode;
    expect(split.children[1]?.node).toEqual(leafOf("c"));
    expect(split.children[1]?.size).toBe(3);
    expect(split.children[2]?.node).toEqual(leafOf("b"));
  });

  it("appends to a stack with grow 1 by default", () => {
    const tree = treeOf(stackOf({ node: leafOf("a"), grow: 1 }));
    const result = insertLeaf(tree, [], "b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stack = result.tree.root as StackNode;
    expect(stack.children[1]?.grow).toBe(1);
  });

  it("inserts a bare leaf into a panels node (alias of insertPanel)", () => {
    const tree = treeOf(panelsOf("tabs", "model"));
    const result = insertLeaf(tree, [], "extensions", { index: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(viewsOfPanels(result.tree.root as PanelsNode)).toEqual(["tabs", "extensions", "model"]);
  });

  it("insertPanel appends to the addressed panels node by id", () => {
    const tree = defaultTree();
    const result = insertPanel(tree, "side", "settings");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const side = result.tree.root as SplitNode;
    const panels = side.children[1]?.node as PanelsNode;
    expect(viewsOfPanels(panels)).toEqual(["tabs", "model", "settings"]);
  });

  it("rejects out-of-range indices and non-containers", () => {
    const tree = treeOf(panelsOf("tabs"));
    expect(insertPanel(tree, [], "x", { index: 5 }).ok).toBe(false);
    expect(insertLeaf(tree, [], "x").ok).toBe(true); // root panels IS a container
    const leafTree = treeOf(leafOf("a"));
    expect(insertLeaf(leafTree, [], "b").ok).toBe(false);
  });
});

describe("removeNode", () => {
  it("removes a middle child and keeps the tree valid", () => {
    const tree = treeOf(panelsOf("tabs", "model", "settings"));
    const result = removeNode(tree, [1]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(viewsOfPanels(result.tree.root as PanelsNode)).toEqual(["tabs", "settings"]);
  });

  it("removes a node addressed by id", () => {
    const tree = treeOf(stackOf({ node: leafOf("a", "first"), grow: 1 }, { node: leafOf("b") }));
    const result = removeNode(tree, "first");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.tree.root as StackNode).children).toHaveLength(1);
  });

  it("refuses to remove the last child of a container", () => {
    const tree = treeOf(panelsOf("tabs"));
    const result = removeNode(tree, [0]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("last child");
  });

  it("refuses to remove the root", () => {
    const tree = treeOf(panelsOf("tabs"));
    expect(removeNode(tree, []).ok).toBe(false);
  });

  it("unsets the titlebar", () => {
    const tree: LayoutTree = { version: 1, titlebar: leafOf("brand"), root: leafOf("chat") };
    const result = removeNode(tree, ["titlebar"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.titlebar).toBeUndefined();
    expect("titlebar" in result.tree).toBe(false);
  });
});

describe("moveNode", () => {
  it("moves a child between containers", () => {
    const tree = treeOf(
      splitOf(
        { node: stackOf({ node: leafOf("a"), grow: 1 }, { node: leafOf("b") }), size: 1 },
        { node: stackOf({ node: leafOf("c") }), size: 1 },
      ),
    );
    // Move leaf "b" (path [0,1]) to the second stack (path [1]) at index 0.
    const result = moveNode(tree, [0, 1], [1], { index: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const split = result.tree.root as SplitNode;
    const left = split.children[0]?.node as StackNode;
    const right = split.children[1]?.node as StackNode;
    expect(left.children.map((c) => (c.node as LeafNode).view)).toEqual(["a"]);
    expect(right.children.map((c) => (c.node as LeafNode).view)).toEqual(["b", "c"]);
  });

  it("handles same-container moves with index adjustment (move forward)", () => {
    const tree = treeOf(panelsOf("a", "b", "c"));
    // Move panel 0 ("a") to the end: after removal ["b","c"], index 2 = end.
    const result = moveNode(tree, [0], [], { index: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(viewsOfPanels(result.tree.root as PanelsNode)).toEqual(["b", "c", "a"]);
  });

  it("handles same-container backward moves", () => {
    const tree = treeOf(panelsOf("a", "b", "c"));
    const result = moveNode(tree, [2], [], { index: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(viewsOfPanels(result.tree.root as PanelsNode)).toEqual(["c", "a", "b"]);
  });

  it("rejects cycles: moving a node into its own subtree", () => {
    const tree = treeOf(
      splitOf(
        { node: stackOf({ node: leafOf("a"), grow: 1 }), size: 1 },
        { node: leafOf("b"), size: 1 },
      ),
    );
    // Move the whole left stack into itself.
    expect(moveNode(tree, [0], [0]).ok).toBe(false);
  });

  it("rejects moving a non-leaf into a panels node", () => {
    const tree = treeOf(
      splitOf(
        { node: stackOf({ node: leafOf("a"), grow: 1 }), size: 1 },
        { node: panelsOf("x"), size: 1 },
      ),
    );
    const result = moveNode(tree, [0], [1]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("panels");
  });

  it("fails when the source container would be left empty", () => {
    const tree = treeOf(
      splitOf(
        { node: stackOf({ node: leafOf("a"), grow: 1 }), size: 1 },
        { node: stackOf({ node: leafOf("b") }), size: 1 },
      ),
    );
    // Removing leaf "a" would leave the left stack childless.
    const result = moveNode(tree, [0, 0], [1]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("last child");
  });
});

describe("setSizes", () => {
  it("sets sizes preserving basis/collapsible", () => {
    const tree = defaultTree();
    const result = setSizes(tree, "root", [2, 3]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const split = result.tree.root as SplitNode;
    expect(split.children[0]?.size).toBe(2);
    expect(split.children[1]?.size).toBe(3);
    expect(split.children[1]?.basis).toBe(320);
    expect(split.children[1]?.collapsible).toBe(true);
  });

  it("rejects mismatched lengths and invalid sizes", () => {
    const tree = defaultTree();
    expect(setSizes(tree, "root", [1]).ok).toBe(false);
    expect(setSizes(tree, "root", [-1, 1]).ok).toBe(false);
    expect(setSizes(tree, "root", [Number.NaN, 1]).ok).toBe(false);
  });

  it("rejects an all-zero split without basis children", () => {
    const tree = treeOf(splitOf({ node: leafOf("a"), size: 1 }, { node: leafOf("b"), size: 1 }));
    expect(setSizes(tree, [], [0, 0]).ok).toBe(false);
    // …but an all-zero set is fine when a fixed-basis child anchors the split.
    const withBasis = treeOf(
      splitOf({ node: leafOf("a"), size: 0, basis: 100 }, { node: leafOf("b"), size: 1 }),
    );
    expect(setSizes(withBasis, [], [0, 0]).ok).toBe(true);
  });
});

describe("splitLeaf", () => {
  it("turns a leaf into a split of the old leaf + a new one (after)", () => {
    const tree = treeOf(stackOf({ node: leafOf("a"), grow: 1 }));
    const result = splitLeaf(tree, [0], "b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stack = result.tree.root as StackNode;
    const split = stack.children[0]?.node as SplitNode;
    expect(split.kind).toBe("split");
    expect(split.children.map((c) => (c.node as LeafNode).view)).toEqual(["a", "b"]);
  });

  it("preserves the old child's slot attributes on the new split", () => {
    const tree = treeOf(
      splitOf(
        { node: leafOf("a"), size: 0, basis: 200, collapsible: true },
        { node: leafOf("b"), size: 1 },
      ),
    );
    const result = splitLeaf(tree, [0], "c");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const split = result.tree.root as SplitNode;
    const wrapper = split.children[0];
    expect(wrapper?.size).toBe(0);
    expect(wrapper?.basis).toBe(200);
    expect(wrapper?.collapsible).toBe(true);
    const inner = wrapper?.node as SplitNode;
    expect(inner.children.map((c) => (c.node as LeafNode).view)).toEqual(["a", "c"]);
  });

  it("supports newSide before and a custom new leaf size", () => {
    const tree = treeOf(leafOf("a"));
    const result = splitLeaf(tree, [], "b", { dir: "col", newSide: "before", newLeafSize: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const split = result.tree.root as SplitNode;
    expect(split.dir).toBe("col");
    expect(split.children[0]?.size).toBe(2);
    expect((split.children[0]?.node as LeafNode).view).toBe("b");
  });

  it("refuses to split a panel leaf", () => {
    const tree = treeOf(panelsOf("tabs"));
    const result = splitLeaf(tree, [0], "model");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("panel");
  });
});

describe("ensureLeaf / ensurePanel", () => {
  it("inserts when missing and reports created", () => {
    const tree = defaultTree();
    const result = ensureLeaf(tree, "main", "tasks");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
  });

  it("is a no-op when the view already exists under the target", () => {
    const tree = defaultTree();
    const result = ensureLeaf(tree, "main", "composer");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.tree).toBe(tree);
  });

  it("ensurePanel is idempotent per panels node", () => {
    const tree = defaultTree();
    const first = ensurePanel(tree, "side", "model");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(false);
    const second = ensurePanel(tree, "side", "settings");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(true);
    const side = second.tree.root as SplitNode;
    expect(viewsOfPanels(side.children[1]?.node as PanelsNode)).toEqual([
      "tabs",
      "model",
      "settings",
    ]);
  });

  it("fails when the target is not a panels node (ensurePanel)", () => {
    const tree = defaultTree();
    expect(ensurePanel(tree, "main", "tasks").ok).toBe(false);
  });
});

describe("applyOps / applyOp", () => {
  it("applies a batch left-to-right", () => {
    const tree = defaultTree();
    const result = applyOps(tree, [
      { type: "insertPanel", panels: "side", view: "settings" },
      // [1, 1] = the side panels node (root child 1), its panel 1 ("model").
      { type: "replaceView", target: [1, 1], view: "tasks" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const side = result.tree.root as SplitNode;
    expect(viewsOfPanels(side.children[1]?.node as PanelsNode)).toEqual([
      "tabs",
      "tasks",
      "settings",
    ]);
  });

  it("is atomic: a failing op fails the whole batch", () => {
    const tree = defaultTree();
    const result = applyOps(tree, [
      { type: "insertPanel", panels: "side", view: "settings" },
      { type: "removeNode", target: "nope" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("round-trips ensureLeaf through applyOp", () => {
    const tree = defaultTree();
    const once = applyOp(tree, { type: "ensureLeaf", container: "main", view: "tasks" });
    expect(once.ok).toBe(true);
    const twice = applyOp(once.ok ? once.tree : tree, {
      type: "ensureLeaf",
      container: "main",
      view: "tasks",
    });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.tree).toBe(once.ok ? once.tree : tree);
  });
});

describe("immutability", () => {
  it("never mutates the input tree", () => {
    const tree = defaultTree();
    const before = structuredClone(tree);
    replaceView(tree, [0, 0], "x");
    insertPanel(tree, "side", "y");
    removeNode(tree, [1]);
    setSizes(tree, "root", [3, 7]);
    splitLeaf(tree, [0, 2], "z");
    moveNode(tree, [1, 0], [0], { index: 0 });
    expect(tree).toEqual(before);
  });
});
