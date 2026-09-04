/**
 * Pure edit operations on layout trees. Every op returns a NEW tree (structural
 * sharing, zero mutation) and is TOTAL: it returns a result object, never
 * throws. Containers left with zero children are invalid (the renderer would
 * show nothing), so ops that would produce one fail loudly instead.
 *
 * All ops accept either a {@link Path} or a node `id` ({@link NodeRef}).
 * These names/shapes are the plugin-facing op vocabulary (plan 04) — the
 * renderer's panel edits emit them today via `applyOps`.
 */

import { isDescendantOrSelf, parentPath, resolveRef } from "./address";
import type {
  EnsureResult,
  LayoutNode,
  LayoutOp,
  LayoutTree,
  LeafNode,
  NodeRef,
  PanelsNode,
  Path,
  SplitChild,
  SplitNode,
  StackChild,
  StackNode,
  TreeResult,
} from "./tree";

type OpFailure = { readonly ok: false; readonly error: string };

function fail(error: string): OpFailure {
  return { ok: false, error };
}

function ok(tree: LayoutTree): { ok: true; tree: LayoutTree } {
  return { ok: true, tree };
}

function isContainer(node: LayoutNode): node is SplitNode | StackNode | PanelsNode {
  return node.kind === "split" || node.kind === "stack" || node.kind === "panels";
}

function leaf(view: string): LeafNode {
  return { kind: "leaf", view };
}

/** Is `index` a valid insertion point in an array of length `length`? */
function validIndex(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index <= length;
}

/**
 * Rebuild the node at `path` with `rebuild` applied to it (immutably — parents
 * are re-created along the way, untouched subtrees are shared). A `["titlebar", …]`
 * path rebuilds the titlebar slot. Unknown shapes are programming errors (the
 * path must have come from `resolveRef` on this same tree).
 */
function rebuild(
  tree: LayoutTree,
  path: Path,
  rebuildNode: (node: LayoutNode) => LayoutNode,
): LayoutTree {
  if (path.length === 0) return { ...tree, root: rebuildNode(tree.root) };
  if (path[0] === "titlebar") {
    if (tree.titlebar === undefined) return tree;
    if (path.length === 1) return { ...tree, titlebar: rebuildNode(tree.titlebar) };
    return { ...tree, titlebar: rebuildDescendant(tree.titlebar, path.slice(1), rebuildNode) };
  }
  return { ...tree, root: rebuildDescendant(tree.root, path, rebuildNode) };
}

function rebuildDescendant(
  node: LayoutNode,
  path: Path,
  rebuildNode: (n: LayoutNode) => LayoutNode,
): LayoutNode {
  if (path.length === 0) return rebuildNode(node);
  const [head, ...rest] = path;
  const i = typeof head === "number" ? head : -1;
  if (node.kind === "split") {
    const children = node.children.map((child, j) =>
      j === i ? { ...child, node: rebuildDescendant(child.node, rest, rebuildNode) } : child,
    );
    return { ...node, children };
  }
  if (node.kind === "stack") {
    const children = node.children.map((child, j) =>
      j === i ? { ...child, node: rebuildDescendant(child.node, rest, rebuildNode) } : child,
    );
    return { ...node, children };
  }
  if (node.kind === "panels") {
    const panels = node.panels.map((panel, j) => {
      if (j !== i) return panel;
      const rebuilt = rebuildDescendant(panel, rest, rebuildNode);
      // Panels only ever hold leaves (guarded by validateTree); a rebuild that
      // would produce a non-leaf here is a caller bug — keep the panel as-is.
      return rebuilt.kind === "leaf" ? rebuilt : panel;
    });
    return { ...node, panels };
  }
  return node;
}

/** The uniform child list of a container (for splicing). */
function spliceChildren(
  node: SplitNode | StackNode | PanelsNode,
  index: number,
  removed: number,
  inserted?: SplitChild | StackChild | LeafNode,
): SplitNode | StackNode | PanelsNode {
  if (node.kind === "split") {
    const children = [...node.children];
    if (inserted !== undefined) children.splice(index, removed, inserted as SplitChild);
    else children.splice(index, removed);
    return { ...node, children };
  }
  if (node.kind === "stack") {
    const children = [...node.children];
    if (inserted !== undefined) children.splice(index, removed, inserted as StackChild);
    else children.splice(index, removed);
    return { ...node, children };
  }
  const panels = [...node.panels];
  if (inserted !== undefined) panels.splice(index, removed, inserted as LeafNode);
  else panels.splice(index, removed);
  return { ...node, panels };
}

/** The child count of a container (for index validation + append). */
function childCount(node: LayoutNode): number {
  if (node.kind === "split") return node.children.length;
  if (node.kind === "stack") return node.children.length;
  if (node.kind === "panels") return node.panels.length;
  return 0;
}

/**
 * Replace the view a leaf mounts. Fails when the target is not a leaf.
 */
export function replaceView(tree: LayoutTree, target: NodeRef, view: string): TreeResult {
  const resolved = resolveRef(tree, target);
  if (!resolved.ok) return fail(resolved.error);
  const { node } = resolved.value;
  if (node.kind !== "leaf") return fail(`replaceView: target is a ${node.kind}, not a leaf`);
  return ok(rebuild(tree, resolved.value.path, () => ({ ...node, view })));
}

/**
 * Insert a new leaf mounting `view` into a container (split/stack/panels).
 * Splits give the child `{ size: opts.size ?? 1 }`, stacks `{ grow: opts.grow ?? 1 }`,
 * panels append the bare leaf (an alias of `insertPanel`). Appends by default.
 */
export function insertLeaf(
  tree: LayoutTree,
  container: NodeRef,
  view: string,
  opts?: { readonly index?: number; readonly size?: number; readonly grow?: number },
): TreeResult {
  const resolved = resolveRef(tree, container);
  if (!resolved.ok) return fail(resolved.error);
  const { node, path } = resolved.value;
  if (!isContainer(node)) return fail(`insertLeaf: target is a ${node.kind}, not a container`);
  const index = opts?.index ?? childCount(node);
  if (!validIndex(index, childCount(node))) {
    return fail(
      `insertLeaf: index ${index} out of range (container has ${childCount(node)} children)`,
    );
  }
  if (node.kind === "panels") return insertPanel(tree, path, view, { index });
  const next = rebuild(tree, path, (n) => {
    if (n.kind === "split") {
      return spliceChildren(n, index, 0, { node: leaf(view), size: opts?.size ?? 1 });
    }
    if (n.kind === "stack") {
      return spliceChildren(n, index, 0, { node: leaf(view), grow: opts?.grow ?? 1 });
    }
    if (n.kind === "panels") {
      return spliceChildren(n, index, 0, leaf(view));
    }
    return n;
  });
  return ok(next);
}

/**
 * Insert a panel (a bare leaf) into a panels node. Appends by default.
 */
export function insertPanel(
  tree: LayoutTree,
  panels: NodeRef,
  view: string,
  opts?: { readonly index?: number },
): TreeResult {
  const resolved = resolveRef(tree, panels);
  if (!resolved.ok) return fail(resolved.error);
  const { node, path } = resolved.value;
  if (node.kind !== "panels")
    return fail(`insertPanel: target is a ${node.kind}, not a panels node`);
  const index = opts?.index ?? node.panels.length;
  if (!validIndex(index, node.panels.length)) {
    return fail(
      `insertPanel: index ${index} out of range (panels node has ${node.panels.length} panels)`,
    );
  }
  return ok(
    rebuild(tree, path, (n) => (n.kind === "panels" ? spliceChildren(n, index, 0, leaf(view)) : n)),
  );
}

/**
 * Remove the addressed node from its parent. The root cannot be removed; the
 * titlebar can (it becomes unset). Fails when the source container would be
 * left with zero children (an empty split/stack/panels is invalid).
 */
export function removeNode(tree: LayoutTree, target: NodeRef): TreeResult {
  const resolved = resolveRef(tree, target);
  if (!resolved.ok) return fail(resolved.error);
  const { path } = resolved.value;
  if (path.length === 0) return fail("removeNode: cannot remove the root");
  if (path.length === 1 && path[0] === "titlebar") {
    return ok({ version: 1, root: tree.root });
  }
  const pp = parentPath(path);
  const index = path[path.length - 1];
  if (typeof index !== "number") return fail("removeNode: invalid path");
  const parent = resolveRef(tree, pp);
  if (!parent.ok) return fail(parent.error);
  const parentNode = parent.value.node;
  if (!isContainer(parentNode))
    return fail(`removeNode: parent is a ${parentNode.kind}, not a container`);
  if (childCount(parentNode) <= 1) {
    return fail(
      `removeNode: removing the last child of a ${parentNode.kind} is not allowed (it would be empty)`,
    );
  }
  return ok(rebuild(tree, pp, (n) => (isContainer(n) ? spliceChildren(n, index, 1) : n)));
}

/**
 * Move a subtree into a container at `index` (post-removal positions; append
 * by default). Fails when: the target is the root; the destination is inside
 * the moved subtree; the destination is a panels node and the moved node is
 * not a leaf; or the source container would be left empty.
 */
export function moveNode(
  tree: LayoutTree,
  target: NodeRef,
  container: NodeRef,
  opts?: { readonly index?: number },
): TreeResult {
  const from = resolveRef(tree, target);
  if (!from.ok) return fail(from.error);
  const to = resolveRef(tree, container);
  if (!to.ok) return fail(to.error);
  const srcPath = from.value.path;
  const dstPath = to.value.path;
  if (srcPath.length === 0) return fail("moveNode: cannot move the root");
  if (isDescendantOrSelf(dstPath, srcPath)) {
    return fail("moveNode: cannot move a node into itself or its own subtree");
  }
  if (
    to.value.node.kind !== "split" &&
    to.value.node.kind !== "stack" &&
    to.value.node.kind !== "panels"
  ) {
    return fail(`moveNode: destination is a ${to.value.node.kind}, not a container`);
  }
  if (to.value.node.kind === "panels" && from.value.node.kind !== "leaf") {
    return fail(`moveNode: a panels node can only hold leaves, not a ${from.value.node.kind}`);
  }

  const removed = removeNode(tree, srcPath);
  if (!removed.ok) return removed;
  const srcParentPath = parentPath(srcPath);
  const sameParent =
    srcParentPath.length === dstPath.length && isDescendantOrSelf(srcParentPath, dstPath);
  let index = opts?.index ?? childCount(to.value.node) - 1;
  if (sameParent && typeof dstPath[dstPath.length - 1] === "number") {
    // Same-container move: the removal shifts later indices down by one.
    const srcIndex = srcPath[srcPath.length - 1];
    const dstIndex = dstPath[dstPath.length - 1];
    if (typeof srcIndex === "number" && typeof dstIndex === "number" && dstIndex > srcIndex)
      index -= 1;
  }
  return insertNode(removed.tree, dstPath, from.value.node, index);
}

/** Insert an EXISTING node into the container at `path` (used by moveNode). */
function insertNode(
  tree: LayoutTree,
  containerPath: Path,
  node: LayoutNode,
  index: number,
): TreeResult {
  const resolved = resolveRef(tree, containerPath);
  if (!resolved.ok) return fail(resolved.error);
  const { node: container } = resolved.value;
  if (!isContainer(container))
    return fail(`moveNode: destination is a ${container.kind}, not a container`);
  if (!validIndex(index, childCount(container))) {
    return fail(
      `moveNode: index ${index} out of range (container has ${childCount(container)} children)`,
    );
  }
  return ok(
    rebuild(tree, containerPath, (n) => {
      if (n.kind === "split") return spliceChildren(n, index, 0, { node, size: 1 });
      if (n.kind === "stack") return spliceChildren(n, index, 0, { node, grow: 1 });
      if (n.kind === "panels" && node.kind === "leaf") return spliceChildren(n, index, 0, node);
      return n;
    }),
  );
}

/**
 * Set the flex-grow sizes of a split's children (`basis`/`collapsible` are
 * preserved). Fails on length mismatch, negative/non-finite sizes, or an
 * all-zero set (the split would render zero-width).
 */
export function setSizes(tree: LayoutTree, split: NodeRef, sizes: readonly number[]): TreeResult {
  const resolved = resolveRef(tree, split);
  if (!resolved.ok) return fail(resolved.error);
  const { node, path } = resolved.value;
  if (node.kind !== "split") return fail(`setSizes: target is a ${node.kind}, not a split`);
  if (sizes.length !== node.children.length) {
    return fail(`setSizes: expected ${node.children.length} sizes, got ${sizes.length}`);
  }
  if (!sizes.every((s) => Number.isFinite(s) && s >= 0)) {
    return fail("setSizes: sizes must be finite non-negative numbers");
  }
  const sum = sizes.reduce((a, b) => a + b, 0);
  const anyBasis = node.children.some((c) => c.basis !== undefined);
  if (sum <= 0 && !anyBasis) {
    return fail("setSizes: at least one size must be positive (the split would collapse)");
  }
  return ok(
    rebuild(tree, path, (n) => {
      if (n.kind !== "split") return n;
      return {
        ...n,
        children: n.children.map((child, i) => ({ ...child, size: sizes[i] ?? child.size })),
      };
    }),
  );
}

/**
 * Turn a leaf into a split containing the old leaf and a new leaf mounting
 * `view`. The old child's slot (size/basis/collapsible) moves to the new
 * split; inside it both leaves get size 1 (override with `newLeafSize`).
 * Fails on non-leaf targets and on panel leaves (a panels node only holds
 * leaves — split the panels node's parent instead).
 */
export function splitLeaf(
  tree: LayoutTree,
  target: NodeRef,
  view: string,
  opts?: {
    readonly dir?: "row" | "col";
    readonly newSide?: "before" | "after";
    readonly newLeafSize?: number;
  },
): TreeResult {
  const resolved = resolveRef(tree, target);
  if (!resolved.ok) return fail(resolved.error);
  const { node, path } = resolved.value;
  if (node.kind !== "leaf") return fail(`splitLeaf: target is a ${node.kind}, not a leaf`);
  const dir = opts?.dir ?? "row";
  const oldChild: SplitChild = { node, size: 1 };
  const newChild: SplitChild = { node: leaf(view), size: opts?.newLeafSize ?? 1 };
  const splitOf = (first: SplitChild, second: SplitChild): SplitNode => ({
    kind: "split",
    dir,
    children: opts?.newSide === "before" ? [second, first] : [first, second],
  });
  if (path.length === 0) {
    return ok({ version: 1, root: splitOf(oldChild, newChild) });
  }
  const pp = parentPath(path);
  const parent = resolveRef(tree, pp);
  if (!parent.ok) return fail(parent.error);
  if (parent.value.node.kind === "panels") {
    return fail("splitLeaf: cannot split a panel leaf (panels only hold leaves)");
  }
  return ok(
    rebuild(tree, pp, (n) => {
      if (n.kind === "split") {
        const children = n.children.map((child) => {
          if (child.node !== node) return child;
          const split = splitOf({ node: child.node, size: 1 }, newChild);
          // The old child's slot (size/basis/collapsible) moves onto the split
          // that replaces it, so the new pair inherits the old slot's geometry.
          const wrapper: SplitChild =
            child.basis === undefined
              ? { node: split, size: child.size }
              : { node: split, size: child.size, basis: child.basis };
          return child.collapsible === undefined
            ? wrapper
            : { ...wrapper, collapsible: child.collapsible };
        });
        return { ...n, children };
      }
      if (n.kind === "stack") {
        const children = n.children.map((child): StackChild => {
          if (child.node !== node) return child;
          const split = splitOf({ node: child.node, size: 1 }, newChild);
          return child.grow === undefined ? { node: split } : { node: split, grow: child.grow };
        });
        return { ...n, children };
      }
      return n;
    }),
  );
}

/**
 * Idempotent insert: when a leaf mounting `view` already exists anywhere under
 * the target container, the tree is returned unchanged (`created: false`);
 * otherwise it behaves like `insertLeaf` (`created: true`).
 */
export function ensureLeaf(
  tree: LayoutTree,
  container: NodeRef,
  view: string,
  opts?: { readonly index?: number; readonly size?: number; readonly grow?: number },
): EnsureResult {
  const resolved = resolveRef(tree, container);
  if (!resolved.ok) return fail(resolved.error);
  if (hasLeafView(resolved.value.node, view)) return { ok: true, tree, created: false };
  const inserted = insertLeaf(tree, container, view, opts);
  if (!inserted.ok) return inserted;
  return { ok: true, tree: inserted.tree, created: true };
}

/**
 * Idempotent `insertPanel`: no-op (`created: false`) when the panels node
 * already contains a leaf mounting `view`.
 */
export function ensurePanel(
  tree: LayoutTree,
  panels: NodeRef,
  view: string,
  opts?: { readonly index?: number },
): EnsureResult {
  const resolved = resolveRef(tree, panels);
  if (!resolved.ok) return fail(resolved.error);
  if (resolved.value.node.kind !== "panels") {
    return fail(`ensurePanel: target is a ${resolved.value.node.kind}, not a panels node`);
  }
  if (hasLeafView(resolved.value.node, view)) return { ok: true, tree, created: false };
  const inserted = insertPanel(tree, panels, view, opts);
  if (!inserted.ok) return inserted;
  return { ok: true, tree: inserted.tree, created: true };
}

function hasLeafView(node: LayoutNode, view: string): boolean {
  if (node.kind === "leaf") return node.view === view;
  return childrenOf(node).some((child) => hasLeafView(child, view));
}

function childrenOf(node: LayoutNode): readonly LayoutNode[] {
  if (node.kind === "split") return node.children.map((c) => c.node);
  if (node.kind === "stack") return node.children.map((c) => c.node);
  if (node.kind === "panels") return node.panels;
  return [];
}

/** Apply one {@link LayoutOp} (the data form of the op vocabulary). */
export function applyOp(tree: LayoutTree, op: LayoutOp): TreeResult {
  switch (op.type) {
    case "replaceView":
      return replaceView(tree, op.target, op.view);
    case "insertLeaf":
      return insertLeaf(tree, op.container, op.view, {
        ...(op.index === undefined ? null : { index: op.index }),
      });
    case "insertPanel":
      return insertPanel(tree, op.panels, op.view, {
        ...(op.index === undefined ? null : { index: op.index }),
      });
    case "removeNode":
      return removeNode(tree, op.target);
    case "moveNode":
      return moveNode(tree, op.target, op.container, {
        ...(op.index === undefined ? null : { index: op.index }),
      });
    case "setSizes":
      return setSizes(tree, op.split, op.sizes);
    case "splitLeaf":
      return splitLeaf(tree, op.target, op.view, {
        ...(op.dir === undefined ? null : { dir: op.dir }),
        ...(op.newSide === undefined ? null : { newSide: op.newSide }),
        ...(op.newLeafSize === undefined ? null : { newLeafSize: op.newLeafSize }),
      });
    case "ensureLeaf":
      return ensureLeaf(tree, op.container, op.view);
    case "ensurePanel":
      return ensurePanel(tree, op.panels, op.view);
  }
}

/** Apply ops left-to-right, fail-fast. The tree is only replaced when ALL ops succeed. */
export function applyOps(tree: LayoutTree, ops: readonly LayoutOp[]): TreeResult {
  let current = tree;
  for (const op of ops) {
    const result = applyOp(current, op);
    if (!result.ok) return result;
    current = result.tree;
  }
  return ok(current);
}
