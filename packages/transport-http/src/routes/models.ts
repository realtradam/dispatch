import type { ModelsResponse } from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";
import { usablePluginsInWorkspace } from "../seam.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  app.get("/models", async (c) => {
    // Per-workspace provider gate (plan 06 §6.5): with `workspaceId` the
    // catalog is filtered to providers whose OWNING plugin is usable in that
    // workspace (loaded globally AND enabled there — `isPluginUsable`).
    // Attribution via the plan-01 ledger (`PluginOwnership.ownerOfProvider`),
    // NOT manifests. WITHOUT the param the route is the global catalog —
    // backward compatible, no service needed. With the param, an absent
    // config/ownership service degrades to 503 (never silently unfiltered).
    const workspaceId = c.req.query("workspaceId");
    try {
      const entries = await opts.credentialStore.listCatalogDetailed();
      let visible = entries;
      if (workspaceId !== undefined) {
        const config = opts.workspacePluginConfigService;
        const ownership = opts.pluginOwnership;
        const tierOf = opts.pluginTierOf;
        if (config === undefined || ownership === undefined || tierOf === undefined) {
          return c.json({ error: "Workspace plugin config service not available" }, 503);
        }
        // Provider id per catalog entry (`resolve` is a local map lookup —
        // no I/O). An unresolvable entry is KEPT (fail-open — it has no
        // attributable provider to gate).
        const providerIdOfEntry = new Map<string, string>();
        const providerIds = new Set<string>();
        for (const entry of entries) {
          const resolved = opts.credentialStore.resolve(entry.name);
          if (resolved === undefined) continue;
          providerIdOfEntry.set(entry.name, resolved.providerId);
          providerIds.add(resolved.providerId);
        }
        // Provider → owning plugin → usable set (the ONE pure rule shared
        // with the tool gate + surface filter). An UNATTRIBUTABLE provider
        // (no ledger owner, or owner not classifiable) is KEPT — fail-open;
        // global loaded/unloaded state already gates it.
        const ownerOf = new Map<string, string>();
        for (const providerId of providerIds) {
          const owner = ownership.ownerOfProvider(providerId);
          if (owner !== undefined) ownerOf.set(providerId, owner);
        }
        const usableOwners = await usablePluginsInWorkspace(
          workspaceId,
          [...new Set(ownerOf.values())],
          config,
          tierOf,
        );
        const usableProviders = new Set<string>();
        for (const providerId of providerIds) {
          const owner = ownerOf.get(providerId);
          if (owner === undefined) {
            usableProviders.add(providerId); // unattributable → fail-open
          } else if (usableOwners.has(owner)) {
            usableProviders.add(providerId);
          }
        }
        visible = entries.filter((entry) => {
          const providerId = providerIdOfEntry.get(entry.name);
          if (providerId === undefined) return true; // unresolvable → fail-open
          return usableProviders.has(providerId);
        });
      }
      const models = visible.map((e) => e.name);
      const modelInfo: Record<string, { contextWindow?: number; vision?: boolean }> = {};
      for (const entry of visible) {
        if (entry.info.contextWindow !== undefined || entry.info.vision === true) {
          const infoEntry: { contextWindow?: number; vision?: boolean } = {};
          if (entry.info.contextWindow !== undefined)
            infoEntry.contextWindow = entry.info.contextWindow;
          if (entry.info.vision === true) infoEntry.vision = true;
          modelInfo[entry.name] = infoEntry;
        }
      }
      const body: ModelsResponse = {
        models,
        ...(Object.keys(modelInfo).length > 0 ? { modelInfo } : {}),
      };
      return c.json(body, 200);
    } catch (err) {
      log.error("models: failed to retrieve catalog", { err });
      return c.json({ error: "Failed to retrieve model catalog" }, 502);
    }
  });
}
