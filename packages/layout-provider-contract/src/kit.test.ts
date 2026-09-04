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
import { DEFAULT_LAYOUT, type LayoutTree } from "@dispatch/layout-contract";
import type { LayoutChangedMessage } from "@dispatch/transport-contract";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createLayoutProvider,
  createLayoutRouteHandlers,
  type LayoutRouteResult,
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
      getProvider: () => undefined,
      logger: silentLogger,
    });
    const emptyBody = { tree: DEFAULT_LAYOUT };
    for (const outcome of [
      await routes.get("ws-a"),
      await routes.put("ws-a", emptyBody),
      await routes.delete("ws-a"),
    ]) {
      expect(outcome.status).toBe(404);
      expect(outcome.body).toEqual({ error: "No layout provider is active" });
    }
  });

  it("GET → 200 { tree } (seeds a fresh workspace) with a live provider", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: () => h.provider,
      logger: silentLogger,
    });
    const result: LayoutRouteResult = await routes.get("fresh-ws");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tree: DEFAULT_LAYOUT });
  });

  it("PUT with a malformed body → 400 (absent provider still wins with 404 first)", async () => {
    const h = makeHarness();
    const routes = createLayoutRouteHandlers({
      getProvider: () => h.provider,
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
      getProvider: () => h.provider,
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
      getProvider: () => h.provider,
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
      getProvider: () => h.provider,
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
      getProvider: () => provider,
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
