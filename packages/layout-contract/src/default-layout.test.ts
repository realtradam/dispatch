import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT } from "./default-layout";
import type { PanelsNode, SplitNode, StackNode } from "./tree";
import { validateTree } from "./validate";

describe("DEFAULT_LAYOUT", () => {
  it("is structurally valid on its own", () => {
    expect(validateTree(DEFAULT_LAYOUT)).toEqual({ ok: true });
  });

  it("reproduces today's layout: main stack left, collapsible panels right", () => {
    const root = DEFAULT_LAYOUT.root as SplitNode;
    expect(root.kind).toBe("split");
    expect(root.dir).toBe("row");
    expect(root.id).toBe("root");

    const main = root.children[0];
    expect(main?.size).toBe(1);
    const stack = main?.node as StackNode;
    expect(stack.id).toBe("main");
    expect(stack.children.map((c) => (c.node.kind === "leaf" ? c.node.view : ""))).toEqual([
      "chat",
      "message-queue",
      "composer",
    ]);
    // The chat region grows; the message-queue panel + composer take natural height.
    expect(stack.children[0]?.grow).toBe(1);
    expect(stack.children[1]?.grow).toBeUndefined();
    expect(stack.children[2]?.grow).toBeUndefined();

    const side = root.children[1];
    expect(side?.size).toBe(0);
    expect(side?.basis).toBe(320); // today's w-80
    expect(side?.collapsible).toBe(true);
    const panels = side?.node as PanelsNode;
    expect(panels.id).toBe("side");
    expect(panels.panels.map((p) => p.view)).toEqual(["tabs", "model"]); // today's DEFAULT_VIEWS
  });

  it("leaves the titlebar slot UNSET (D-L5)", () => {
    expect(DEFAULT_LAYOUT.titlebar).toBeUndefined();
    expect("titlebar" in DEFAULT_LAYOUT).toBe(false);
  });
});
