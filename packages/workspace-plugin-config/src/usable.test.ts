import type { PluginTier } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import type { WorkspacePluginConfigService } from "./service.js";
import { usablePluginsInWorkspace } from "./usable.js";

/** A structural fake of the config service — only `stateOf` is required. */
function fakeConfig(
  states: ReadonlyMap<string, "enabled" | "disabled" | undefined>,
): Pick<WorkspacePluginConfigService, "stateOf"> {
  return {
    async stateOf(workspaceId, pluginId) {
      return states.get(`${workspaceId}/${pluginId}`);
    },
  };
}

const tiers: ReadonlyMap<string, PluginTier> = new Map([
  ["core-plugin", "core"],
  ["provider-a", "providers"],
  ["std-tool", "standard"],
]);

describe("usablePluginsInWorkspace (the shared enforcement-plane rule)", () => {
  const config = fakeConfig(
    new Map([
      ["team-a/core-plugin", "enabled"],
      ["team-a/provider-a", "disabled"],
      ["team-a/std-tool", "enabled"],
    ]),
  );
  const tierOf = (id: string) => tiers.get(id);

  it("core usable; disabled providers not; enabled standard usable", async () => {
    const usable = await usablePluginsInWorkspace(
      "team-a",
      ["core-plugin", "provider-a", "std-tool"],
      config,
      tierOf,
    );
    expect(usable.has("core-plugin")).toBe(true);
    expect(usable.has("provider-a")).toBe(false);
    expect(usable.has("std-tool")).toBe(true);
  });

  it("fail-open: an unclassifiable plugin id (no tier) is treated USABLE", async () => {
    const usable = await usablePluginsInWorkspace("team-a", ["ghost"], config, tierOf);
    expect(usable.has("ghost")).toBe(true);
  });

  it("deduplicates repeated plugin ids (one stateOf per distinct plugin)", async () => {
    let calls = 0;
    const counting = {
      async stateOf() {
        calls += 1;
        return "enabled" as const;
      },
    };
    const usable = await usablePluginsInWorkspace(
      "team-a",
      ["provider-a", "provider-a", "std-tool", "provider-a"],
      counting,
      tierOf,
    );
    expect(calls).toBe(2);
    expect(usable.has("provider-a")).toBe(true);
  });
});
