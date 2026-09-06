/**
 * The diagnostic tree derivation — the whole point of the plugin, pinned:
 * DIAGNOSTIC_LAYOUT is DEFAULT_LAYOUT plus (only) the two root-tile markers.
 * If the default tree's shape ever drifts, the "preserves the default"
 * assertions here fail loudly so the derivation is updated in step.
 */

import { DEFAULT_LAYOUT, validateTree } from "@dispatch/layout-contract";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_LAYOUT, deriveDiagnosticLayout } from "./tree.js";

/** The ids of the two root tiles whose markers the diagnostic tree adds. */
const MARKED_IDS = new Set(["main", "side"]);

describe("deriveDiagnosticLayout", () => {
  it("is structurally the DEFAULT_LAYOUT: markers stripped, the trees deep-equal", () => {
    expect(stripMarkers(DIAGNOSTIC_LAYOUT)).toEqual(DEFAULT_LAYOUT);
  });

  it("preserves the ids, stack, panels, sizes, basis, and collapsible of the default", () => {
    // A structural spot-check over the well-known default shape (ids are part
    // of the default tree's contract — "root" split, "main" stack, "side"
    // panels).
    const root = DIAGNOSTIC_LAYOUT.root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") return;
    expect(root.id).toBe("root");
    expect(root.children).toHaveLength(2);

    const [mainChild, sideChild] = root.children;
    expect(mainChild?.node.id).toBe("main");
    expect(mainChild?.node.kind).toBe("stack");
    expect(mainChild?.size).toBe(1);
    if (mainChild?.node.kind !== "stack") return;
    expect(mainChild.node.children.map((c) => c.node.view)).toEqual([
      "chat",
      "message-queue",
      "composer",
    ]);

    expect(sideChild?.node.id).toBe("side");
    expect(sideChild?.node.kind).toBe("panels");
    expect(sideChild?.size).toBe(0);
    expect(sideChild?.basis).toBe(320);
    expect(sideChild?.collapsible).toBe(true);
    if (sideChild?.node.kind !== "panels") return;
    expect(sideChild.node.panels.map((p) => p.view)).toEqual(["tabs", "model"]);
  });

  it("marks EXACTLY the two root tiles: main → 'main' (red), side → 'side' (green)", () => {
    const root = DIAGNOSTIC_LAYOUT.root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") return;
    for (const child of root.children) {
      if (MARKED_IDS.has(child.node.id ?? "")) {
        expect(child.node.marker).toBe(child.node.id);
      } else {
        expect(child.node.marker).toBeUndefined();
      }
    }
    // …and nothing else in the tree carries a marker.
    expect(countMarkers(DIAGNOSTIC_LAYOUT.root)).toBe(2);
  });

  it("does not mutate DEFAULT_LAYOUT (the derivation is pure)", () => {
    // Re-deriving must yield the same tree, and the shared base must still be
    // marker-free — the contract's default stays untouched.
    const before = JSON.stringify(DEFAULT_LAYOUT);
    deriveDiagnosticLayout(DEFAULT_LAYOUT);
    expect(JSON.stringify(DEFAULT_LAYOUT)).toBe(before);
  });

  it("passes validateTree as-is", () => {
    expect(validateTree(DIAGNOSTIC_LAYOUT)).toEqual({ ok: true });
  });

  it("derives from a non-split base unchanged (nothing to mark — degrades to the base)", () => {
    const base = { version: 1, root: { kind: "leaf", view: "chat" } } as const;
    expect(deriveDiagnosticLayout(base)).toEqual(base);
  });
});

/** A fresh marker-free copy of a tree (the diff seam for "default + markers only"). */
function stripMarkers(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(stripMarkers);
  if (typeof tree !== "object" || tree === null) return tree;
  const record = tree as Record<string, unknown>;
  const { marker: _marker, ...rest } = record;
  void _marker;
  for (const [key, value] of Object.entries(rest)) rest[key] = stripMarkers(value);
  return rest;
}

/** Count nodes carrying a marker, recursively. */
function countMarkers(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum, n) => sum + countMarkers(n), 0);
  if (typeof node !== "object" || node === null) return 0;
  const record = node as Record<string, unknown>;
  let count = "marker" in record ? 1 : 0;
  for (const value of Object.values(record)) count += countMarkers(value);
  return count;
}
