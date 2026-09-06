/**
 * The default layout — the Addendum-A compatibility tree that reproduces
 * today's UI exactly: main column on the left (chat above the message-queue
 * panel above the composer), scrolling swappable panels on the right.
 *
 * Exported from the contract (decision 1) so the plan-02 seed plugin and the
 * frontend fallback renderer share one source of truth and can never drift.
 * The `titlebar` slot is deliberately UNSET (D-L5): the chrome top bar stays
 * shell chrome.
 */

import type { LayoutTree } from "./tree";

export const DEFAULT_LAYOUT: LayoutTree = {
  version: 1,
  root: {
    kind: "split",
    id: "root",
    dir: "row",
    children: [
      {
        size: 1,
        node: {
          kind: "stack",
          id: "main",
          children: [
            { grow: 1, node: { kind: "leaf", view: "chat" } },
            { node: { kind: "leaf", view: "message-queue" } },
            { node: { kind: "leaf", view: "composer" } },
          ],
        },
      },
      {
        size: 0,
        basis: 320,
        collapsible: true,
        node: {
          kind: "panels",
          id: "side",
          panels: [
            { kind: "leaf", view: "tabs" },
            { kind: "leaf", view: "model" },
          ],
        },
      },
    ],
  },
};
