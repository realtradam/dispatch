/**
 * Kit unit tests (plan 02 verification gate) — seed/materialize idempotence,
 * validation rejection, event-after-write exactly once, DELETE→re-seed
 * round-trip, and the route-handler 404/400/200 matrix.
 *
 * Zero internal mocks (AGENTS.md): the edges injected here are REAL
 * in-memory implementations — a Map-backed `StorageNamespace` (the same
 * shape the kernel's own tests + plugin-verify's test host use), a silent
 * `Logger`, and a recording `emitChange` callback (the injected emitter is
 * the edge; recording its calls is what a unit test IS). The provider logic
 * itself is the code under test, unmocked.
 */

import type { StorageNamespace } from "@dispatch/kernel";
import { createLogger } from "@dispatch/kernel";
import { DEFAULT_LAYOUT, findById, type LayoutTree } from "@dispatch/layout-contract";
import type { LayoutChangedMessage } from "@dispatch/transport-contract";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createLayoutProvider,
  createLayoutRouteHandlers,
  type LayoutRouteResult,
  parseOpsBody,
  parseTreeBody,
} from "./kit";

/** Real in-memory StorageNamespace (no Dispatch mocks — the plugin-verify pattern). */
function memoryStorage(): StorageNamespace & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    has: async (key) => store.has(key),
    keys: async () => [...store.keys()],
  };
}

/** Silent logger — the kernel's real createLogger over a no-op sink. */
const silentLogger = createLogger(
  { extensionId: "kit-test" },
  { emit: () => {} },
  {
    now: () => 0,
    newId: () => "kit-test",
  },
);

/** Recording emitChange edge — collects every emitted wire message. */
function recordingEmit(): {
  readonly events: LayoutChangedMessage[];
  readonly emit: (message: LayoutChangedMessage) => void;
} {
  const events: LayoutChangedMessage[] = [];
  return { events, emit: (message) => events.push(message) };
}

/** A minimally-valid tree DIFFERENT from DEFAULT_LAYOUT (chat-only main). */
function otherTree(): LayoutTree {
  return {
    version: 1,
    root: { kind: "leaf", view: "chat" },
  };
}

interface Harness {
  readonly storage: ReturnType<typeof memoryStorage>;
  readonly events: LayoutChangedMessage[];
  readonly provider: ReturnType<typeof createLayoutProvider>;
}

function makeHarness(defaultTree: LayoutTree = DEFAULT_LAYOUT): Harness {
  const storage = memoryStorage();
  const emit = recordingEmit();
  const provider = createLayoutProvider({
    storage,
    defaultTree,
    emitChange: emit.emit,
    logger: silentLogger,
  });
  return { storage, events: emit.events, provider };
}

describe("createLayoutProvider — seed + materialize", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("getTree on a fresh workspace seeds DEFAULT_LAYOUT (read-through)", async () => {
    const tree = await h.provider.getTree("ws-a");
    expect(tree).toEqual(DEFAULT_LAYOUT);
    // Materialized on first read: the storage record exists.
    expect(h.storage.store.get("tree:ws-a")).toBe(JSON.stringify(DEFAULT_LAYOUT));
  });

  it("materialization is idempotent — the second read returns the STORED record (no re-seed overwrite)", async () => {
    const first = await h.provider.getTree("ws-a");
    expect(first).toEqual(DEFAULT_LAYOUT);
    // Simulate a stored record drifting from the seed: if the provider
    // re-seeded on every read, this drift would be overwritten.
    const drifted = otherTree();
    h.storage.store.set("tree:ws-a", JSON.stringify(drifted));
    const second = await h.provider.getTree("ws-a");
    expect(second).toEqual(drifted);
    expect(h.storage.store.get("tree:ws-a")).toBe(JSON.stringify(drifted));
  });

  it("workspaces are keyed independently", async () => {
    await h.provider.setTree("ws-a", otherTree());
    expect(await h.provider.getTree("ws-a")).toEqual(otherTree());
    expect(await h.provider.getTree("ws-b")).toEqual(DEFAULT_LAYOUT);
  });

  it("a corrupt stored record (bad JSON) is a miss — the read re-seeds", async () => {
    h.storage.store.set("tree:ws-a", "not json");
    const tree = await h.provider.getTree("ws-a");
    expect(tree).toEqual(DEFAULT_LAYOUT);
    expect(h.storage.store.get("tree:ws-a")).toBe(JSON.stringify(DEFAULT_LAYOUT));
  });

  it("a corrupt stored record (bad shape) is a miss — the read re-seeds", async () => {
    h.storage.store.set("tree:ws-a", JSON.stringify({ version: 3, root: "junk" }));
    const tree = await h.provider.getTree("ws-a");
    expect(tree).toEqual(DEFAULT_LAYOUT);
  });

  it("a read-triggered seed does NOT emit a change event (reads are not writes)", async () => {
    await h.provider.getTree("ws-a");
    expect(h.events).toEqual([]);
  });
});

describe("createLayoutProvider — setTree (validation + event-after-write)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("a valid tree persists and emits the layout event EXACTLY ONCE", async () => {
    const tree = otherTree();
    const result = await h.provider.setTree("ws-a", tree);
    expect(result).toEqual({ ok: true, tree });
    expect(h.storage.store.get("tree:ws-a")).toBe(JSON.stringify(tree));
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toEqual({ type: "layout", workspaceId: "ws-a", tree });
  });

  it("an invalid tree is rejected (structural violation): not persisted, NO event", async () => {
    const bad = { version: 1, root: { kind: "split", dir: "row", children: [] } } as unknown;
    const result = await h.provider.setTree("ws-a", bad as LayoutTree);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no children");
    expect(h.storage.store.has("tree:ws-a")).toBe(false);
    expect(h.events).toEqual([]);
  });

  it("duplicate node ids are rejected on write", async () => {
    const bad = {
      version: 1,
      root: {
        kind: "split",
        dir: "row",
        children: [
          { size: 1, node: { kind: "leaf", id: "dup", view: "chat" } },
          { size: 1, node: { kind: "leaf", id: "dup", view: "tabs" } },
        ],
      },
    } as unknown;
    const result = await h.provider.setTree("ws-a", bad as LayoutTree);
    expect(result.ok).toBe(false);
    expect(h.events).toEqual([]);
  });

  it("UNKNOWN view ids are NOT a validation failure (renderer fallback concern)", async () => {
    const tree: LayoutTree = {
      version: 1,
      root: { kind: "leaf", view: "future-calendar-view" },
    };
    const result = await h.provider.setTree("ws-a", tree);
    expect(result.ok).toBe(true);
    expect(h.events).toHaveLength(1);
  });

  it("a zero-size child without a basis is rejected", async () => {
    const bad = {
      version: 1,
      root: {
        kind: "split",
        dir: "row",
        children: [
          { size: 0, node: { kind: "leaf", view: "chat" } },
          { size: 1, node: { kind: "leaf", view: "tabs" } },
        ],
      },
    } as unknown;
    const result = await h.provider.setTree("ws-a", bad as LayoutTree);
    expect(result.ok).toBe(false);
  });
});

describe("createLayoutProvider — resetTree (DELETE → re-seed)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("DELETE removes the record, returns the fresh seed, and emits once", async () => {
    await h.provider.setTree("ws-a", otherTree());
    h.events.length = 0;

    const tree = await h.provider.resetTree("ws-a");
    expect(tree).toEqual(DEFAULT_LAYOUT);
    expect(h.storage.store.has("tree:ws-a")).toBe(false);
    expect(h.events).toEqual([{ type: "layout", workspaceId: "ws-a", tree: DEFAULT_LAYOUT }]);

    // The next read re-seeds (round-trip back to the default).
    expect(await h.provider.getTree("ws-a")).toEqual(DEFAULT_LAYOUT);
    expect(h.storage.store.get("tree:ws-a")).toBe(JSON.stringify(DEFAULT_LAYOUT));
  });

  it("DELETE on a never-written workspace is a harmless re-seed", async () => {
    const tree = await h.provider.resetTree("fresh");
    expect(tree).toEqual(DEFAULT_LAYOUT);
  });
});

// ── Route handlers ───────────────────────────────────────────────────────────

describe("createLayoutRouteHandlers — 404/400/200 matrix", () => {
  it("every route 404s while no provider is active (the no-provider signal)", async () => {
    const routes = createLayoutRouteHandlers({
      getProvider: async () => undefined,
      logger: silentLogger,
    });
    const emptyBody = { tree: DEFAULT_LAYOUT };
    for (const outcome of [
      await routes.get("ws-a"),
      await routes.put("ws-a", emptyBody),
      await routes.delete("ws-a"),
    ]) {
      expect(outcome.status).toBe(404);
      expect(outcome.body).toEqual({ error: "No layout plugin is enabled in this workspace" });
    }
  });

  it("GET → 200 { tree } (seeds a fresh workspace) with a live provider", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: async () => h.provider,
      logger: silentLogger,
    });
    const result: LayoutRouteResult = await routes.get("fresh-ws");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tree: DEFAULT_LAYOUT });
  });

  it("PUT with a malformed body → 400 (absent provider still wins with 404 first)", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: async () => h.provider,
      logger: silentLogger,
    });
    for (const bad of [undefined, "junk", 42, {}, { tree: null }, { tree: { version: 2 } }]) {
      const result = await routes.put("ws-a", bad);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: expect.any(String) });
    }
  });

  it("PUT with a structurally invalid tree → 400 { error } (from validateTree)", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: async () => h.provider,
      logger: silentLogger,
    });
    const bad = { tree: { version: 1, root: { kind: "split", dir: "row", children: [] } } };
    const result = await routes.put("ws-a", bad);
    expect(result.status).toBe(400);
    if (!("tree" in result.body)) expect(result.body.error).toContain("no children");
  });

  it("PUT with a valid tree → 200 { tree } and persists + emits (exactly once)", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: async () => h.provider,
      logger: silentLogger,
    });
    const result = await routes.put("ws-a", { tree: otherTree() });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tree: otherTree() });
    expect(h.events).toHaveLength(1);
  });

  it("DELETE → 200 { tree: freshSeed }; a following GET re-seeds to the default", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: async () => h.provider,
      logger: silentLogger,
    });
    await routes.put("ws-a", { tree: otherTree() });
    h.events.length = 0;

    const del = await routes.delete("ws-a");
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ tree: DEFAULT_LAYOUT });

    const get = await routes.get("ws-a");
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ tree: DEFAULT_LAYOUT });
    // The DELETE emitted once; the re-seeding GET did not.
    expect(h.events).toHaveLength(1);
  });

  it("a provider whose storage throws → 500 (never a crash)", async () => {
    const explosive: StorageNamespace = {
      get: async () => {
        throw new Error("disk gone");
      },
      set: async () => {
        throw new Error("disk gone");
      },
      delete: async () => {
        throw new Error("disk gone");
      },
      has: async () => {
        throw new Error("disk gone");
      },
      keys: async () => {
        throw new Error("disk gone");
      },
    };
    const provider = createLayoutProvider({
      storage: explosive,
      defaultTree: DEFAULT_LAYOUT,
      emitChange: () => {},
      logger: silentLogger,
    });
    const routes = createLayoutRouteHandlers({
      getProvider: async () => provider,
      logger: silentLogger,
    });
    const result = await routes.get("ws-a");
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Layout storage failure" });
  });
});

describe("parseTreeBody", () => {
  it("accepts { tree } and returns the tree", () => {
    const parsed = parseTreeBody({ tree: DEFAULT_LAYOUT });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.tree).toBe(DEFAULT_LAYOUT);
  });

  it("rejects non-objects, missing trees, and wrong versions with specific errors", () => {
    for (const bad of [null, "x", [], {}, { tree: "x" }, { tree: { version: 2, root: {} } }]) {
      const parsed = parseTreeBody(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });
});

// ── applyOps (plan 04 §4.2) — atomic op batches ─────────────────────────────
//
// DEFAULT_LAYOUT (the harness seed): root split "root" [ stack "main"
// (chat, message-queue, composer) | panels "side" (tabs, model) ]. Paths:
// "main" = [0], "side" = [1].

describe("createLayoutProvider — applyOps (plan 04)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("the op vocabulary folds through the dispatcher and persists + broadcasts EXACTLY ONCE", async () => {
    await h.provider.getTree("ws-a"); // seed first (a known baseline)
    h.events.length = 0;

    const result = await h.provider.applyOps("ws-a", [
      { type: "ensurePanel", panels: "side", view: "tabs" }, // no-op (already present)
      { type: "insertLeaf", container: "main", view: "tasks" }, // stack append
      { type: "replaceView", target: [0, 0], view: "notes" }, // main's first leaf
      { type: "setSizes", split: "root", sizes: [2, 1] }, // root split sizes
      { type: "splitLeaf", target: [0, 1], view: "status", dir: "col" }, // split main's 2nd leaf
      { type: "moveNode", target: [0, 3], container: "side" }, // move the tasks leaf into the panels
      { type: "removeNode", target: [0, 2] }, // drop the composer leaf
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(7);
    // The batch is ONE write: exactly one change event, carrying the FOLDED tree.
    expect(h.events.length).toBe(1);
    expect(h.events[0]?.workspaceId).toBe("ws-a");
    expect(h.events[0]?.tree).toEqual(result.tree);
    // Persisted (the folded tree, byte for byte).
    expect(h.storage.store.get("tree:ws-a")).toBe(JSON.stringify(result.tree));
  });

  it("atomicity: a failing op N rejects the whole batch — the stored tree is byte-identical and NOTHING broadcasts", async () => {
    await h.provider.getTree("ws-a");
    h.events.length = 0;
    const before = h.storage.store.get("tree:ws-a");

    const result = await h.provider.applyOps("ws-a", [
      { type: "insertPanel", panels: "side", view: "tasks" }, // WOULD change the tree
      { type: "removeNode", target: "root" }, // fails: the root cannot be removed
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedOp).toBe(1);
    expect(result.error).toContain("op 1");
    // Byte-identical storage + zero events: the fold never reached persistence.
    expect(h.storage.store.get("tree:ws-a")).toBe(before);
    expect(h.events.length).toBe(0);
  });

  it("a failing op's error names the op's index; ensure-ops count as applied-but-unchanged", async () => {
    await h.provider.getTree("ws-a");

    const bad = await h.provider.applyOps("ws-a", [
      { type: "insertPanel", panels: "side", view: "tasks" },
      { type: "insertPanel", panels: "no-such-node", view: "tasks" }, // unknown id → fails at index 1
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.failedOp).toBe(1);
      expect(bad.error).toContain("op 1");
    }

    const first = await h.provider.applyOps("ws-a", [
      { type: "ensurePanel", panels: "side", view: "tasks" },
    ]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.applied).toBe(1); // applied (created)

    // Re-run: the view is present → applied-but-UNCHANGED (still counts).
    const second = await h.provider.applyOps("ws-a", [
      { type: "ensurePanel", panels: "side", view: "tasks" },
    ]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.applied).toBe(1);
    expect(second.tree).toEqual(first.tree);
  });

  it("id-first addressing survives structural edits that invalidate numeric paths", async () => {
    await h.provider.getTree("ws-a");

    // By ID: "side" is the default tree's panels node (its ids are contract).
    const byId = await h.provider.applyOps("ws-a", [
      { type: "ensurePanel", panels: "side", view: "tasks" },
    ]);
    expect(byId.ok).toBe(true);

    // By PATH: [1] addresses the same panels node today…
    const byPath = await h.provider.applyOps("ws-a", [
      { type: "ensurePanel", panels: [1], view: "composer" },
    ]);
    expect(byPath.ok).toBe(true);
    if (byPath.ok) {
      const side = findById(byPath.tree, "side");
      expect(side?.node.kind).toBe("panels");
      if (side?.node.kind === "panels") {
        expect(side.node.panels.some((p) => p.view === "composer")).toBe(true);
      }
    }

    // …but a structural edit upstream SHIFTS paths: prepending a root child
    // moves "side" from [1] to [2], so the old path now addresses the stack —
    // the path batch fails (atomic, nothing persisted) while the id stays true.
    const afterEdit = await h.provider.applyOps("ws-a", [
      { type: "insertLeaf", container: "root", index: 0, view: "tasks" },
      { type: "ensurePanel", panels: [1], view: "message-queue" }, // [1] is now the stack "main"
    ]);
    expect(afterEdit.ok).toBe(false);
    if (!afterEdit.ok) expect(afterEdit.failedOp).toBe(1);

    const check = await h.provider.getTree("ws-a");
    const side = findById(check, "side");
    expect(side?.node.kind).toBe("panels");
    if (side?.node.kind === "panels") {
      expect(side.node.panels.some((p) => p.view === "tasks")).toBe(true);
    }
  });

  it("the FOLDED result is validated before persist: a drifted (invalid) stored tree is rejected", async () => {
    // Bypass the validated writes: simulate a drifted record (the storage
    // shape-check only guards version+root, so a structurally invalid tree
    // can be planted here — exactly what the folded validation defends
    // against at apply time).
    h.storage.store.set(
      "tree:ws-a",
      JSON.stringify({ version: 1, root: { kind: "split", dir: "row", children: [] } }),
    );
    const result = await h.provider.applyOps("ws-a", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid tree");
  });

  it("an EMPTY ops list succeeds with applied: 0 and is NOT a write (no persist, no event)", async () => {
    await h.provider.getTree("ws-a");
    h.events.length = 0;
    const before = h.storage.store.get("tree:ws-a");

    const result = await h.provider.applyOps("ws-a", []);
    expect(result).toEqual({ ok: true, tree: expect.anything(), applied: 0 });
    expect(h.events.length).toBe(0);
    expect(h.storage.store.get("tree:ws-a")).toBe(before);
  });

  it("wire junk (a malformed op) becomes a failedOp — never a crash", async () => {
    await h.provider.getTree("ws-a");
    // A missing/garbage ref makes the pure op THROW at this untyped boundary;
    // the provider converts it into a failed-op result.
    const junk = await h.provider.applyOps("ws-a", [
      { type: "ensurePanel", panels: undefined as unknown as string, view: "tasks" },
    ]);
    expect(junk.ok).toBe(false);
    if (!junk.ok) {
      expect(junk.failedOp).toBe(0);
      expect(junk.error).toContain("op 0");
    }
  });

  it("applies against the tree as read at apply time: a fresh workspace is seeded first (read-through)", async () => {
    // No prior getTree — applyOps itself must seed, then fold over the seed.
    const result = await h.provider.applyOps("ws-a", [
      { type: "ensurePanel", panels: "side", view: "tasks" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findById(result.tree, "side")?.node.kind).toBe("panels");
    const stored = h.storage.store.get("tree:ws-a");
    expect(stored).toBe(JSON.stringify(result.tree));
  });
});

describe("createLayoutRouteHandlers — POST ops (plan 04, the second door)", () => {
  it("404s while no provider is active (before body validation)", async () => {
    const routes = createLayoutRouteHandlers({
      getProvider: async () => undefined,
      logger: silentLogger,
    });
    const result = await routes.ops("ws-a", { ops: [] });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "No layout plugin is enabled in this workspace" });
  });

  it("a malformed body → 400; a known-typed op with junk fields → 400 with failedOp", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: async () => h.provider,
      logger: silentLogger,
    });

    const noArray = await routes.ops("ws-a", { ops: "junk" });
    expect(noArray.status).toBe(400);

    const badType = await routes.ops("ws-a", { ops: [{ type: "teleport" }] });
    expect(badType.status).toBe(400);
    expect(badType.body).toEqual({ error: expect.stringContaining("ops[0]") });

    const junkFields = await routes.ops("ws-a", { ops: [{ type: "ensurePanel", view: "x" }] });
    expect(junkFields.status).toBe(400);
    expect(junkFields.body).toEqual({
      error: expect.stringContaining("op 0"),
      failedOp: 0,
    });
  });

  it("200 { tree, applied } on success — the SAME kit applyOps (one code path, two doors)", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: async () => h.provider,
      logger: silentLogger,
    });
    const result = await routes.ops("ws-a", {
      ops: [{ type: "ensurePanel", panels: "side", view: "tasks" }],
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tree: expect.anything(), applied: 1 });
    if ("tree" in result.body) {
      expect(findById(result.body.tree, "side")?.node.kind).toBe("panels");
    }
    // Exactly one broadcast for the write.
    expect(h.events.length).toBe(1);
  });
});

describe("parseOpsBody", () => {
  it("accepts { ops: [...] } with known op types", () => {
    const parsed = parseOpsBody({
      ops: [
        { type: "ensurePanel", panels: "side", view: "tasks" },
        { type: "setSizes", split: [0], sizes: [1, 2] },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.ops.length).toBe(2);
  });

  it("rejects non-objects, a missing/non-array ops, and unknown op types", () => {
    for (const bad of [
      null,
      "x",
      42,
      {},
      { ops: "junk" },
      { ops: [{}] },
      { ops: [{ type: 3 }] },
      { ops: [{ type: "teleport" }] },
    ]) {
      const parsed = parseOpsBody(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });
});

describe("createLayoutRouteHandlers — POST ops (plan 04, the second door)", () => {
  it("404s while no provider is active (before body validation)", async () => {
    const routes = createLayoutRouteHandlers({
      getProvider: async () => undefined,
      logger: silentLogger,
    });
    const result = await routes.ops("ws-a", { ops: [] });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "No layout plugin is enabled in this workspace" });
  });

  it("a malformed body → 400; a known-typed op with junk fields → 400 with failedOp", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: async () => h.provider,
      logger: silentLogger,
    });

    const noArray = await routes.ops("ws-a", { ops: "junk" });
    expect(noArray.status).toBe(400);

    const badType = await routes.ops("ws-a", { ops: [{ type: "teleport" }] });
    expect(badType.status).toBe(400);
    expect(badType.body).toEqual({ error: expect.stringContaining("ops[0]") });

    const junkFields = await routes.ops("ws-a", { ops: [{ type: "ensurePanel", view: "x" }] });
    expect(junkFields.status).toBe(400);
    expect(junkFields.body).toEqual({
      error: expect.stringContaining("op 0"),
      failedOp: 0,
    });
  });

  it("200 { tree, applied } on success — the same kit applyOps (one code path)", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: async () => h.provider,
      logger: silentLogger,
    });
    const result = await routes.ops("ws-a", {
      ops: [{ type: "ensurePanel", panels: "side", view: "tasks" }],
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tree: expect.anything(), applied: 1 });
    if ("tree" in result.body) {
      expect(findById(result.body.tree, "side")?.node.kind).toBe("panels");
    }
    // Exactly one broadcast for the write.
    expect(h.events.length).toBe(1);
  });
});

describe("parseOpsBody", () => {
  it("accepts { ops: [...] } with known op types", () => {
    const parsed = parseOpsBody({
      ops: [
        { type: "ensurePanel", panels: "side", view: "tasks" },
        { type: "setSizes", split: [0], sizes: [1, 2] },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.ops.length).toBe(2);
  });

  it("rejects non-objects, a missing/non-array ops, and unknown op types (with the index)", () => {
    for (const bad of [
      null,
      "x",
      42,
      {},
      { ops: "junk" },
      { ops: [{}] },
      { ops: [{ type: 3 }] },
      { ops: [{ type: "teleport" }] },
    ]) {
      const parsed = parseOpsBody(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });
});

// ── Per-workspace provider resolution (the routes are workspace-aware) ──────

describe("createLayoutRouteHandlers — per-workspace resolution (the activation gate)", () => {
  /**
   * The route handlers over TWO kit providers (chat + diagnostic), resolved
   * per workspace the way the transport wires it: the layout-provider
   * registry's `providerFor(workspaceId)` decides which plugin serves.
   */
  function makeWorkspaceAwareRoutes(enabledByWorkspace: ReadonlyMap<string, string>) {
    const chat = makeHarness();
    const diagnostic = makeHarness(DIAGNOSTIC_TREE);
    const byId: Record<string, Harness> = {
      "layout-chat": chat,
      "layout-diagnostic": diagnostic,
    };
    const routes = createLayoutRouteHandlers({
      getProvider: async (workspaceId) => {
        const pluginId = enabledByWorkspace.get(workspaceId);
        if (pluginId === undefined) return undefined;
        return byId[pluginId]?.provider;
      },
      logger: silentLogger,
    });
    return { routes, chat, diagnostic };
  }

  function diagnosticTree(): LayoutTree {
    // The diagnostic tree IS the default with markers on the root tiles —
    // any marker-bearing tree exercises "a different provider served this".
    return {
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
              marker: "main",
              children: [{ grow: 1, node: { kind: "leaf", view: "chat" } }],
            },
          },
        ],
      },
    };
  }
  const DIAGNOSTIC_TREE: LayoutTree = diagnosticTree();

  it("the workspace with layout-chat enabled gets the CHAT tree", async () => {
    const { routes } = makeWorkspaceAwareRoutes(new Map([["ws-chat", "layout-chat"]]));
    const result: LayoutRouteResult = await routes.get("ws-chat");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tree: DEFAULT_LAYOUT });
  });

  it("the workspace with layout-diagnostic enabled gets the DIAGNOSTIC tree", async () => {
    const { routes } = makeWorkspaceAwareRoutes(new Map([["ws-diag", "layout-diagnostic"]]));
    const result: LayoutRouteResult = await routes.get("ws-diag");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tree: DIAGNOSTIC_TREE });
  });

  it("each workspace gets its OWN provider's tree (coexisting plugins)", async () => {
    const { routes } = makeWorkspaceAwareRoutes(
      new Map([
        ["ws-chat", "layout-chat"],
        ["ws-diag", "layout-diagnostic"],
      ]),
    );
    expect(await routes.get("ws-chat")).toEqual({ status: 200, body: { tree: DEFAULT_LAYOUT } });
    expect(await routes.get("ws-diag")).toEqual({
      status: 200,
      body: { tree: DIAGNOSTIC_TREE },
    });
  });

  it("a workspace with NO layout plugin enabled → 404 on every route (the degrade)", async () => {
    const { routes } = makeWorkspaceAwareRoutes(new Map()); // nothing enabled anywhere
    for (const outcome of [
      await routes.get("ws-none"),
      await routes.put("ws-none", { tree: DEFAULT_LAYOUT }),
      await routes.delete("ws-none"),
      await routes.ops("ws-none", { ops: [] }),
    ]) {
      expect(outcome.status).toBe(404);
      expect(outcome.body).toEqual({ error: "No layout plugin is enabled in this workspace" });
    }
  });
});
