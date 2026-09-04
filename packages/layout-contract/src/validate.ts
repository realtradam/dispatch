/**
 * Structural validation of layout trees. Pure, total, and independent of the
 * edit ops: `validateTree` walks the tree once and reports EVERY problem it
 * finds (not just the first).
 *
 * `knownViews` is optional: the frontend passes the view registry's ids so a
 * typo'd leaf fails fast in dev; the backend (plan 02+) passes nothing — an
 * unknown view is the renderer's fallback-tile concern, NOT a validation
 * failure.
 */

import type { LayoutNode, LayoutTree, SplitChild } from "./tree";

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

export function validateTree(
  tree: LayoutTree,
  knownViews?: ReadonlySet<string> | readonly string[],
): ValidationResult {
  const errors: string[] = [];
  const known = knownViews === undefined ? undefined : new Set(knownViews);
  const ids = new Set<string>();

  const checkNode = (node: LayoutNode, where: string): void => {
    if (node.id !== undefined) {
      if (node.id === "") errors.push(`${where}: node id must be a non-empty string`);
      else if (ids.has(node.id)) errors.push(`${where}: duplicate node id "${node.id}"`);
      else ids.add(node.id);
    }
    switch (node.kind) {
      case "split": {
        if (node.children.length === 0) {
          errors.push(`${where}: split has no children`);
          break;
        }
        if (node.dir !== "row" && node.dir !== "col") {
          errors.push(
            `${where}: split dir must be "row" or "col", got ${JSON.stringify(node.dir)}`,
          );
        }
        for (const [i, child] of node.children.entries())
          checkChild(child, `${where}/children[${i}]`);
        break;
      }
      case "stack": {
        if (node.children.length === 0) {
          errors.push(`${where}: stack has no children`);
          break;
        }
        for (const [i, child] of node.children.entries()) {
          const at = `${where}/children[${i}]`;
          if (child.grow !== undefined && !(Number.isFinite(child.grow) && child.grow >= 0)) {
            errors.push(`${at}: grow must be a finite non-negative number`);
          }
          checkNode(child.node, at);
        }
        break;
      }
      case "panels": {
        if (node.panels.length === 0) {
          errors.push(`${where}: panels node has no panels`);
          break;
        }
        for (const [i, panel] of node.panels.entries()) checkNode(panel, `${where}/panels[${i}]`);
        break;
      }
      case "leaf": {
        if (typeof node.view !== "string" || node.view === "") {
          errors.push(`${where}: leaf view must be a non-empty string`);
        } else if (known !== undefined && !known.has(node.view)) {
          errors.push(`${where}: leaf mounts unknown view "${node.view}"`);
        }
        break;
      }
    }
  };

  const checkChild = (child: SplitChild, where: string): void => {
    if (!Number.isFinite(child.size) || child.size < 0) {
      errors.push(`${where}: size must be a finite non-negative number`);
    }
    if (child.basis !== undefined && !(Number.isFinite(child.basis) && child.basis > 0)) {
      errors.push(`${where}: basis must be a positive finite number`);
    }
    // A zero-size child with no fixed basis is invisible — almost certainly a
    // tree-authoring bug, not a deliberate zero-width slot.
    if (child.size === 0 && child.basis === undefined) {
      errors.push(`${where}: a zero-size child needs a positive "basis" (fixed pixel size)`);
    }
    checkNode(child.node, where);
  };

  checkNode(tree.root, "root");
  if (tree.titlebar !== undefined) checkNode(tree.titlebar, "titlebar");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
