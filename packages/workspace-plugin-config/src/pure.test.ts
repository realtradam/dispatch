import { describe, expect, it } from "vitest";
import {
  type CatalogPlugin,
  DEFAULT_WORKSPACE_ID,
  decodeStateRecord,
  encodeStateRecord,
  inheritState,
  isPluginUsable,
  MATERIALIZED_MARKER_PLUGIN_ID,
  materializedMarkerKey,
  planMaterialization,
  storageKey,
  validateSetState,
  WORKSPACE_PLUGIN_CONFIG_NAMESPACE,
} from "./pure.js";

const catalog: readonly CatalogPlugin[] = [
  { id: "core-plugin", tier: "core" },
  { id: "provider-a", tier: "providers" },
  { id: "std-tool", tier: "standard" },
];

describe("inheritState (§6.1)", () => {
  it("core tier ALWAYS materializes to enabled (Q-A: enabled-by-default)", () => {
    expect(inheritState("core", "enabled")).toBe("enabled");
    expect(inheritState("core", "disabled")).toBe("enabled");
    expect(inheritState("core", undefined)).toBe("enabled");
  });

  it("providers/standard inherit the default workspace's enabled state", () => {
    expect(inheritState("providers", "enabled")).toBe("enabled");
    expect(inheritState("standard", "enabled")).toBe("enabled");
  });

  it("providers/standard inherit the default workspace's disabled state", () => {
    expect(inheritState("providers", "disabled")).toBe("disabled");
    expect(inheritState("standard", "disabled")).toBe("disabled");
  });

  it("providers/standard with an undefined default state → undefined (blank slate, NOTHING written)", () => {
    expect(inheritState("providers", undefined)).toBeUndefined();
    expect(inheritState("standard", undefined)).toBeUndefined();
  });
});

describe("isPluginUsable (§6.2)", () => {
  it("core: enabled and undefined (blank slate) are usable; explicit disabled is not", () => {
    expect(isPluginUsable("core", "enabled")).toBe(true);
    expect(isPluginUsable("core", undefined)).toBe(true);
    expect(isPluginUsable("core", "disabled")).toBe(false);
  });

  it("providers/standard: only an explicit enabled is usable — undefined behaves disabled (blank slate)", () => {
    for (const tier of ["providers", "standard"] as const) {
      expect(isPluginUsable(tier, "enabled")).toBe(true);
      expect(isPluginUsable(tier, undefined)).toBe(false);
      expect(isPluginUsable(tier, "disabled")).toBe(false);
    }
  });
});

describe("planMaterialization (§6.1 read-through, pure)", () => {
  it("core materializes to enabled even when the default workspace has it undefined", () => {
    const writes = planMaterialization([{ id: "core-plugin", tier: "core" }], new Map(), new Map());
    expect(writes).toEqual([{ pluginId: "core-plugin", state: "enabled" }]);
  });

  it("core materializes to enabled even when the default workspace explicitly disabled it", () => {
    const writes = planMaterialization(
      [{ id: "core-plugin", tier: "core" }],
      new Map(),
      new Map([["core-plugin", "disabled"]]),
    );
    expect(writes).toEqual([{ pluginId: "core-plugin", state: "enabled" }]);
  });

  it("providers/standard inherit the default workspace's state verbatim", () => {
    const defaultStates = new Map<string, "enabled" | "disabled" | undefined>([
      ["provider-a", "enabled"],
      ["std-tool", "disabled"],
    ]);
    const writes = planMaterialization(catalog, new Map(), defaultStates);
    expect(writes).toEqual([
      { pluginId: "core-plugin", state: "enabled" }, // catalog order — the core rule
      { pluginId: "provider-a", state: "enabled" },
      { pluginId: "std-tool", state: "disabled" },
    ]);
  });

  it("an inherited undefined produces NO write (blank slate — never written)", () => {
    const writes = planMaterialization(catalog, new Map(), new Map());
    expect(writes).toEqual([{ pluginId: "core-plugin", state: "enabled" }]);
  });

  it("fill-gaps-only: an existing per-workspace record is NEVER overwritten", () => {
    const workspaceStates = new Map<string, "enabled" | "disabled" | undefined>([
      ["provider-a", "disabled"],
      ["core-plugin", "disabled"],
    ]);
    const defaultStates = new Map<string, "enabled" | "disabled" | undefined>([
      ["provider-a", "enabled"],
    ]);
    const writes = planMaterialization(catalog, workspaceStates, defaultStates);
    // Only std-tool is missing — and it inherits undefined → no write at all.
    expect(writes).toEqual([]);
  });

  it("materializing the DEFAULT workspace itself (empty defaultStates): core → enabled, blank slate for the rest", () => {
    const writes = planMaterialization(catalog, new Map(), new Map());
    expect(writes).toEqual([{ pluginId: "core-plugin", state: "enabled" }]);
  });

  it("a plugin recorded in the workspace keeps its record even when the default changed", () => {
    const workspaceStates = new Map<string, "enabled" | "disabled" | undefined>([
      ["std-tool", "enabled"],
    ]);
    const defaultStates = new Map<string, "enabled" | "disabled" | undefined>([
      ["std-tool", "disabled"],
    ]);
    const writes = planMaterialization(catalog, workspaceStates, defaultStates);
    // std-tool keeps its explicit record (fill-gaps-only); provider-a
    // inherits undefined → NO write; core materializes to enabled.
    expect(writes).toEqual([{ pluginId: "core-plugin", state: "enabled" }]);
  });
});

describe("validateSetState (§6.6)", () => {
  it("accepts a loaded non-core plugin", () => {
    expect(validateSetState("provider-a", catalog)).toEqual({ ok: true });
    expect(validateSetState("std-tool", catalog)).toEqual({ ok: true });
  });

  it("refuses an UNLOADED plugin (not in the loaded catalog)", () => {
    expect(validateSetState("ghost", catalog)).toEqual({ ok: false, reason: "unloaded" });
  });

  it("refuses a CORE plugin (core-locked — only the global manager loads code)", () => {
    expect(validateSetState("core-plugin", catalog)).toEqual({
      ok: false,
      reason: "core-locked",
    });
  });
});

describe("storage codec", () => {
  it("DEFAULT_WORKSPACE_ID is the well-known synthesized id", () => {
    expect(DEFAULT_WORKSPACE_ID).toBe("default");
  });

  it("the namespace + keys follow the documented layout", () => {
    expect(WORKSPACE_PLUGIN_CONFIG_NAMESPACE).toBe("workspace-plugin-config");
    expect(storageKey("default", "mcp")).toBe("default/mcp");
    expect(materializedMarkerKey("default")).toBe("default/__materialized__");
    expect(MATERIALIZED_MARKER_PLUGIN_ID).toBe("__materialized__");
  });

  it("encodeStateRecord/decodeStateRecord round-trip state + tier", () => {
    const json = encodeStateRecord("enabled", "providers");
    expect(decodeStateRecord(json)).toEqual({ state: "enabled", tier: "providers" });
    expect(decodeStateRecord(encodeStateRecord("disabled", "core"))).toEqual({
      state: "disabled",
      tier: "core",
    });
  });

  it("decodeStateRecord tolerates junk: unparsable, wrong shape, bad state, the marker", () => {
    expect(decodeStateRecord("not json")).toBeUndefined();
    expect(decodeStateRecord("1")).toBeUndefined(); // the materialization marker
    expect(decodeStateRecord("null")).toBeUndefined();
    expect(decodeStateRecord("42")).toBeUndefined();
    expect(decodeStateRecord(JSON.stringify({ state: "other" }))).toBeUndefined();
    expect(decodeStateRecord(JSON.stringify({ state: "enabled", tier: "bogus" }))).toEqual({
      state: "enabled",
    });
  });
});
