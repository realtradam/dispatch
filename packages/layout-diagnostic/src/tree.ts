/**
 * The diagnostic default tree — `DEFAULT_LAYOUT` (the contract's single
 * source of truth) with EXACTLY ONE difference: the two ROOT tiles carry
 * border markers. Everything else is preserved by derivation (ids "root" /
 * "main" / "side", the main stack [chat, message-queue, composer], the side
 * panels [tabs, model], sizes/basis/collapsible) — the diagnostic layout is
 * byte-for-byte the default layout plus two `marker` fields, so a human can
 * visually identify which rendered tile is the `main` stack and which is the
 * `side` panels node.
 *
 * The markers are the contract's additive `TileMarker` presentation field
 * ("main" → red outline, "side" → green outline in the renderer); no
 * structural or behavioral change rides along. If the default tree's shape
 * ever drifts (no root split / the ids move), the derivation marks whatever
 * still matches and skips the rest — the tree degrades to the plain default
 * (and the unit test pins today's expected derivation, so drift fails the
 * build loudly, not the diagnostic silently).
 */

import { DEFAULT_LAYOUT, type LayoutNode, type LayoutTree } from "@dispatch/layout-contract";

/** The diagnostic marker for a root tile, by its well-known id — else none. */
function markerFor(node: LayoutNode): "main" | "side" | undefined {
  if (node.id === "main") return "main";
  if (node.id === "side") return "side";
  return undefined;
}

/** The node with its diagnostic marker attached (pure — always a new object when marked). */
function marked(node: LayoutNode): LayoutNode {
  const marker = markerFor(node);
  return marker === undefined ? node : { ...node, marker };
}

/**
 * Derive the diagnostic tree from `base` (the plan-02 pattern: the plugin's
 * default tree is derived FROM the contract's `DEFAULT_LAYOUT`, never
 * hand-copied, so it can never drift from the default layout's structure).
 * Only the root split's direct children are considered — the well-known root
 * tiles ("main" the left stack, "side" the right panels node).
 */
export function deriveDiagnosticLayout(base: LayoutTree = DEFAULT_LAYOUT): LayoutTree {
  const root = base.root;
  if (root.kind !== "split") return base;
  return {
    ...base,
    root: {
      ...root,
      children: root.children.map((child) => ({ ...child, node: marked(child.node) })),
    },
  };
}

/** The tree the layout-diagnostic plugin seeds fresh workspaces with. */
export const DIAGNOSTIC_LAYOUT: LayoutTree = deriveDiagnosticLayout(DEFAULT_LAYOUT);
