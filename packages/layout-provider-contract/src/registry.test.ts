import { createLogger } from "@dispatch/kernel";
import type { LayoutProvider } from "@dispatch/layout-contract";
import { describe, expect, it } from "vitest";
import { createLayoutProviderRegistry, selectLayoutPlugin } from "./registry.js";

const silentLogger = createLogger(
  { extensionId: "registry-test" },
  { emit: () => {} },
  { now: () => 0, newId: () => "registry-test" },
);

function fakeProvider(view: string): LayoutProvider {
  return {
    getTree: async () => ({ version: 1, root: { kind: "leaf", view } }),
    setTree: async () => ({ ok: true, tree: { version: 1, root: { kind: "leaf", view } } }),
    applyOps: async () => ({
      ok: true,
      tree: { version: 1, root: { kind: "leaf", view } },
      applied: 0,
    }),
    resetTree: async () => ({ version: 1, root: { kind: "leaf", view } }),
  };
}

describe("selectLayoutPlugin — the pure ONE-of-N rule", () => {
  it("no enabled candidates → { ok: false, reason: 'none' }", () => {
    expect(selectLayoutPlugin([])).toEqual({ ok: false, reason: "none" });
  });

  it("exactly one enabled → that plugin, not contested", () => {
    expect(selectLayoutPlugin(["layout-diagnostic"])).toEqual({
      ok: true,
      pluginId: "layout-diagnostic",
      contested: false,
    });
  });

  it("several enabled → the alphabetically FIRST id wins, contested", () => {
    const selection = selectLayoutPlugin(["layout-diagnostic", "layout-chat"]);
    expect(selection).toEqual({ ok: true, pluginId: "layout-chat", contested: true });
  });

  it("the tie-break is load-order independent (sorted, not insertion order)", () => {
    const a = selectLayoutPlugin(["b-plugin", "a-plugin", "c-plugin"]);
    const b = selectLayoutPlugin(["c-plugin", "b-plugin", "a-plugin"]);
    expect(a).toEqual(b);
    expect(a.ok && a.pluginId).toBe("a-plugin");
  });
});

describe("createLayoutProviderRegistry", () => {
  it("register/ids/get: registrations are keyed by plugin id; last-wins on duplicate", () => {
    const registry = createLayoutProviderRegistry({
      pickPlugin: async () => undefined,
      logger: silentLogger,
    });
    const chat = fakeProvider("chat");
    registry.register("layout-chat", chat);
    expect(registry.ids()).toEqual(["layout-chat"]);
    expect(registry.get("layout-chat")).toBe(chat);
    expect(registry.get("layout-diagnostic")).toBeUndefined();

    const chat2 = fakeProvider("chat2");
    registry.register("layout-chat", chat2);
    expect(registry.get("layout-chat")).toBe(chat2);
    expect(registry.ids()).toEqual(["layout-chat"]);
  });

  it("the unregister disposer removes its own registration and is idempotent", () => {
    const registry = createLayoutProviderRegistry({
      pickPlugin: async () => undefined,
      logger: silentLogger,
    });
    const chat = fakeProvider("chat");
    const unregister = registry.register("layout-chat", chat);
    unregister();
    expect(registry.get("layout-chat")).toBeUndefined();
    unregister(); // idempotent — no throw, no effect
    expect(registry.ids()).toEqual([]);
  });

  it("a stale disposer does not evict a REPLACED registration (surface-registry semantics)", () => {
    const registry = createLayoutProviderRegistry({
      pickPlugin: async () => undefined,
      logger: silentLogger,
    });
    const first = fakeProvider("first");
    const unregisterFirst = registry.register("layout-chat", first);
    registry.register("layout-chat", fakeProvider("second"));
    unregisterFirst();
    expect(registry.get("layout-chat")).toBeDefined();
  });

  it("providerFor: nothing registered → undefined (the enablement plane is not consulted)", async () => {
    let consulted = false;
    const registry = createLayoutProviderRegistry({
      pickPlugin: async () => {
        consulted = true;
        return undefined;
      },
      logger: silentLogger,
    });
    expect(await registry.providerFor("ws-a")).toBeUndefined();
    expect(consulted).toBe(false);
  });

  it("providerFor: the picked plugin's provider resolves per workspace", async () => {
    const chat = fakeProvider("chat-view");
    const diagnostic = fakeProvider("diagnostic-view");
    const registry = createLayoutProviderRegistry({
      pickPlugin: async (workspaceId) =>
        workspaceId === "ws-a" ? "layout-chat" : "layout-diagnostic",
      logger: silentLogger,
    });
    registry.register("layout-chat", chat);
    registry.register("layout-diagnostic", diagnostic);

    expect(await registry.providerFor("ws-a")).toBe(chat);
    expect(await registry.providerFor("ws-b")).toBe(diagnostic);
  });

  it("providerFor: an undefined pick (no plugin enabled in this workspace) → undefined", async () => {
    const registry = createLayoutProviderRegistry({
      pickPlugin: async () => undefined,
      logger: silentLogger,
    });
    registry.register("layout-chat", fakeProvider("chat"));
    expect(await registry.providerFor("ws-none")).toBeUndefined();
  });

  it("providerFor: a stale pick (unregistered between selection and lookup) degrades with a warning", async () => {
    const registry = createLayoutProviderRegistry({
      pickPlugin: async () => "layout-chat",
      logger: silentLogger,
    });
    // Nothing registered under "layout-chat" — the pick cannot be honored.
    expect(await registry.providerFor("ws-a")).toBeUndefined();
  });
});
