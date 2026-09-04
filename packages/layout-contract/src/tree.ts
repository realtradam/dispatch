/**
 * Layout contract — the tile-tree schema shared by the renderer (frontend) and
 * the layout store/ops (backend). See `notes/layout-01-tile-engine-view-registry.md`.
 *
 * A LAYOUT TREE is data: a nested composition of splits, stacks, panel stacks,
 * and leaves that mount registered views. The frontend renders it; the backend
 * (plan 02+) owns and persists it. This package is the single source of truth
 * for the schema, the pure tree operations, and the default tree — zero
 * `@dispatch/*` dependencies so a separate client repo can consume just this.
 *
 * All operations are PURE (they return NEW trees, never mutate) and TOTAL
 * (they return a result object, never throw).
 */

/** A row/column split with proportional or fixed-size children. */
export interface SplitChild {
  /** The child subtree. */
  readonly node: LayoutNode;
  /** Flex-grow weight. 0 + `basis` = fixed-size child (today's sidebar). */
  readonly size: number;
  /** Fixed pixel basis when `size` is 0 (e.g. 320 = today's w-80). */
  readonly basis?: number;
  /** Renderer chrome may collapse this child (persists per device). */
  readonly collapsible?: boolean;
}

/** A row (`dir: "row"`) or column (`dir: "col"`) split of its child subtrees. */
export interface SplitNode {
  readonly kind: "split";
  readonly id?: string;
  readonly dir: "row" | "col";
  readonly children: readonly SplitChild[];
}

/** A child of a plain vertical container. `grow` = flex-grow (0 = natural size). */
export interface StackChild {
  readonly node: LayoutNode;
  readonly grow?: number;
}

/** Plain vertical container (today's left column). Children stack top→bottom. */
export interface StackNode {
  readonly kind: "stack";
  readonly id?: string;
  readonly children: readonly StackChild[];
}

/**
 * A scrolling stack of swappable panels with per-panel dropdowns (today's
 * ViewSidebar). Panels are ALWAYS leaves — deeper nesting lives in splits.
 */
export interface PanelsNode {
  readonly kind: "panels";
  readonly id?: string;
  readonly panels: readonly LeafNode[];
}

/** Mounts a registered view (see the frontend's view registry). */
export interface LeafNode {
  readonly kind: "leaf";
  readonly id?: string;
  readonly view: string;
}

export type LayoutNode = SplitNode | StackNode | PanelsNode | LeafNode;

export interface LayoutTree {
  readonly version: 1;
  /**
   * Optional titlebar slot (D-L5): when unset, nothing renders. The default
   * tree leaves it unset — the chrome top bar stays shell chrome.
   */
  readonly titlebar?: LayoutNode;
  readonly root: LayoutNode;
}

/**
 * Address of a node: child indices from the root (a `panels` node indexes its
 * `panels` array; a split/stack indexes its `children`). The first segment may
 * be `"titlebar"` to address the optional titlebar slot.
 */
export type PathSegment = number | "titlebar";
export type Path = readonly PathSegment[];

/**
 * Either a {@link Path} (child indices from the root) or a node `id` (a plain
 * string). Every op accepts either.
 */
export type NodeRef = Path | string;

/**
 * The plugin-facing op vocabulary (plan 04 reuses exactly these). Ops are
 * data — serializable over the wire — and `applyOps` interprets them.
 */
export type LayoutOp =
  | { readonly type: "replaceView"; readonly target: NodeRef; readonly view: string }
  | {
      readonly type: "insertLeaf";
      readonly container: NodeRef;
      readonly view: string;
      readonly index?: number;
    }
  | {
      readonly type: "insertPanel";
      readonly panels: NodeRef;
      readonly view: string;
      readonly index?: number;
    }
  | { readonly type: "removeNode"; readonly target: NodeRef }
  | {
      readonly type: "moveNode";
      readonly target: NodeRef;
      readonly container: NodeRef;
      readonly index?: number;
    }
  | { readonly type: "setSizes"; readonly split: NodeRef; readonly sizes: readonly number[] }
  | {
      readonly type: "splitLeaf";
      readonly target: NodeRef;
      readonly view: string;
      readonly dir?: "row" | "col";
      readonly newSide?: "before" | "after";
      readonly newLeafSize?: number;
    }
  | { readonly type: "ensureLeaf"; readonly container: NodeRef; readonly view: string }
  | { readonly type: "ensurePanel"; readonly panels: NodeRef; readonly view: string };

/** Result of a successful tree op. */
export type TreeResult =
  | { readonly ok: true; readonly tree: LayoutTree }
  | { readonly ok: false; readonly error: string };

/** Result of an idempotent op (`ensureLeaf`/`ensurePanel`): `created` says whether it changed anything. */
export type EnsureResult =
  | { readonly ok: true; readonly tree: LayoutTree; readonly created: boolean }
  | { readonly ok: false; readonly error: string };

/** A node resolved from a tree, with its address from the root. */
export interface ResolvedNode {
  readonly node: LayoutNode;
  readonly path: Path;
}
