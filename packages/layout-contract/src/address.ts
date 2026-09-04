/**
 * Node addressing: resolve a {@link NodeRef} (a path or a node id) to a node in
 * a tree. Pure — no mutation, no throwing.
 */

import type { LayoutNode, LayoutTree, NodeRef, Path, PathSegment, ResolvedNode } from "./tree";

interface ResolveFailure {
  readonly ok: false;
  readonly error: string;
}
interface ResolveSuccess {
  readonly ok: true;
  readonly value: ResolvedNode;
}

/**
 * The children of a container node, uniformized: `[childNode, ...]` for
 * splits/stacks (through their child wrappers) and panels (their leaves).
 * Leaves have no children. The segment that addresses `child[i]` is `i`.
 */
function childrenOf(node: LayoutNode): readonly LayoutNode[] {
  if (node.kind === "split") return node.children.map((c) => c.node);
  if (node.kind === "stack") return node.children.map((c) => c.node);
  if (node.kind === "panels") return node.panels;
  return [];
}

function walk(
  node: LayoutNode,
  path: Path,
  segments: readonly PathSegment[],
): ResolvedNode | string {
  if (segments.length === 0) return { node, path };
  const [head, ...rest] = segments;
  if (typeof head !== "number") {
    return `Invalid path segment ${JSON.stringify(head)} at ${path.length === 0 ? "root" : `depth ${path.length}`}: expected a child index`;
  }
  const kids = childrenOf(node);
  if (head < 0 || head >= kids.length) {
    return `Child index ${head} out of range at path ${JSON.stringify(path)} (${node.kind} has ${kids.length} children)`;
  }
  const child = kids[head];
  if (child === undefined) {
    return `Child index ${head} out of range at path ${JSON.stringify(path)}`;
  }
  return walk(child, [...path, head], rest);
}

/**
 * Resolve a ref to a node. A string is a node id (looked up anywhere in the
 * tree, including the root and the titlebar); an array is a path from the root.
 * Fails with a descriptive error for unknown ids / bad paths.
 */
export function resolveRef(tree: LayoutTree, ref: NodeRef): ResolveSuccess | ResolveFailure {
  if (typeof ref === "string") {
    const found = findById(tree, ref);
    if (found === null) return { ok: false, error: `No node with id "${ref}"` };
    return { ok: true, value: found };
  }
  if (ref.length === 0) return { ok: true, value: { node: tree.root, path: [] } };
  if (ref[0] === "titlebar") {
    const titlebar = tree.titlebar;
    if (titlebar === undefined)
      return { ok: false, error: "The tree has no titlebar (the slot is unset)" };
    if (ref.length === 1) return { ok: true, value: { node: titlebar, path: ["titlebar"] } };
    const rest = ref.slice(1);
    const walked = walk(titlebar, ["titlebar"], rest);
    return typeof walked === "string" ? { ok: false, error: walked } : { ok: true, value: walked };
  }
  const walked = walk(tree.root, [], ref);
  return typeof walked === "string" ? { ok: false, error: walked } : { ok: true, value: walked };
}

/** Look a node up by its `id` (searches the root, titlebar, and every descendant). */
export function findById(tree: LayoutTree, id: string): ResolvedNode | null {
  const seen: ResolvedNode[] = [];
  const visit = (node: LayoutNode, path: Path): void => {
    if (node.id === id) seen.push({ node, path });
    for (const [i, child] of childrenOf(node).entries()) visit(child, [...path, i]);
  };
  visit(tree.root, []);
  if (tree.titlebar !== undefined) {
    visit(tree.titlebar, ["titlebar"]);
  }
  return seen[0] ?? null;
}

/** The parent's path of a path (`[]` for the root / a bare `["titlebar"]`). */
export function parentPath(path: Path): Path {
  return path.slice(0, -1);
}

/** True when `path` addresses the same node as (or a node inside) `ancestor`'s subtree. */
export function isDescendantOrSelf(path: Path, ancestor: Path): boolean {
  if (path.length < ancestor.length) return false;
  return ancestor.every((segment, i) => segment === path[i]);
}
