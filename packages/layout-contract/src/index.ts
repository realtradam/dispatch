/**
 * `@dispatch/layout-contract` — the layout tile-tree schema, its pure
 * operations, the default tree, and the `LayoutProvider` service contract.
 * Zero `@dispatch/*` dependencies; consumed by the frontend via `file:` (like
 * `@dispatch/ui-contract`) and by backend layout plugins (plan 02+).
 */

export {
  findById,
  isDescendantOrSelf,
  parentPath,
  resolveRef,
} from "./address";
export { DEFAULT_LAYOUT } from "./default-layout";
export {
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
export type {
  ApplyOpsResult,
  LayoutProvider,
  SetTreeResult,
} from "./provider";
export type {
  EnsureResult,
  LayoutNode,
  LayoutOp,
  LayoutTree,
  LeafNode,
  PanelsNode,
  Path,
  PathSegment,
  ResolvedNode,
  SplitChild,
  SplitNode,
  StackChild,
  StackNode,
  TreeResult,
} from "./tree";
export { type ValidationResult, validateTree } from "./validate";
