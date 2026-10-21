import type { StorageNamespace } from "@dispatch/kernel";
import type { SearchBackend } from "@dispatch/search-backend-contract";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../../kernel/src/host/storage.test-support.js";
import {
  applyConfigUpdate,
  availableBackends,
  createSearchConfigService,
  DEFAULT_SEARCH_CONFIG,
  resolveSelectedBackend,
  SEARCH_CONFIG_KEY,
} from "./search-config.js";

const firecrawl: SearchBackend = {
  id: "firecrawl",
  label: "Firecrawl (self-hosted)",
  search: () => Promise.resolve([]),
};
const umans: SearchBackend = {
  id: "umans",
  label: "Umans (Exa)",
  search: () => Promise.resolve([]),
};

const REGISTRY = [
  { backend: firecrawl, configured: true },
  { backend: umans, configured: false },
];

function fakeStorage(): StorageNamespace & { dump: () => Map<string, string> } {
  const map = new Map<string, string>();
  return {
    ...storageFromMap(map),
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    keys: async () => [...map.keys()],
    dump: () => map,
  } as unknown as StorageNamespace & { dump: () => Map<string, string> };
}

describe("applyConfigUpdate", () => {
  it("accepts a configured backend", () => {
    const r = applyConfigUpdate(DEFAULT_SEARCH_CONFIG, { backend: "firecrawl" }, REGISTRY);
    expect(r).toEqual({ ok: true, config: { backend: "firecrawl" } });
  });

  it("rejects an unknown backend id", () => {
    const r = applyConfigUpdate(DEFAULT_SEARCH_CONFIG, { backend: "native" }, REGISTRY);
    expect(r).toEqual({ ok: false, error: "unknown-backend" });
  });

  it("rejects a registered-but-unconfigured backend as not-configured", () => {
    const r = applyConfigUpdate(DEFAULT_SEARCH_CONFIG, { backend: "umans" }, REGISTRY);
    expect(r).toEqual({ ok: false, error: "not-configured" });
  });

  it("accepts the explicit 'none' off state", () => {
    const r = applyConfigUpdate(DEFAULT_SEARCH_CONFIG, { backend: "none" }, REGISTRY);
    expect(r).toEqual({ ok: true, config: { backend: "none" } });
  });

  it("rejects a non-string / empty backend", () => {
    expect(applyConfigUpdate(DEFAULT_SEARCH_CONFIG, { backend: "" }, REGISTRY)).toEqual({
      ok: false,
      error: "unknown-backend",
    });
  });

  it("keeps the current value when the patch omits backend", () => {
    const r = applyConfigUpdate({ backend: "umans" }, {}, REGISTRY);
    expect(r).toEqual({ ok: true, config: { backend: "umans" } });
  });
});

describe("availableBackends", () => {
  it("lists every registered backend with its configured gate", () => {
    expect(availableBackends(REGISTRY)).toEqual([
      { id: "firecrawl", label: "Firecrawl (self-hosted)", configured: true },
      { id: "umans", label: "Umans (Exa)", configured: false },
    ]);
  });
});

describe("resolveSelectedBackend", () => {
  it("resolves the configured selected backend", () => {
    expect(resolveSelectedBackend({ backend: "firecrawl" }, REGISTRY)).toBe(firecrawl);
  });

  it("returns null for the 'none' off state", () => {
    expect(resolveSelectedBackend({ backend: "none" }, REGISTRY)).toBeNull();
  });

  it("returns null for an unconfigured or unknown selection (never throws)", () => {
    expect(resolveSelectedBackend({ backend: "umans" }, REGISTRY)).toBeNull();
    expect(resolveSelectedBackend({ backend: "gone" }, REGISTRY)).toBeNull();
  });
});

describe("createSearchConfigService", () => {
  it("returns the default config + availability on first read", async () => {
    const service = createSearchConfigService({ storage: fakeStorage(), registry: REGISTRY });
    expect(await service.getConfig()).toEqual({
      backend: "firecrawl",
      available: availableBackends(REGISTRY),
    });
  });

  it("persists a valid update under the single global key", async () => {
    const storage = fakeStorage();
    const service = createSearchConfigService({ storage, registry: REGISTRY });
    // Make umans configured so the update path is exercised end-to-end.
    const liveRegistry = [
      { backend: firecrawl, configured: true },
      { backend: umans, configured: true },
    ];
    const live = createSearchConfigService({ storage, registry: liveRegistry });
    const result = await live.updateConfig({ backend: "umans" });
    expect(result).toEqual({ ok: true, config: { backend: "umans" } });
    expect(storage.dump().get(SEARCH_CONFIG_KEY)).toBe(JSON.stringify({ backend: "umans" }));
    expect((await service.getConfig()).backend).toBe("umans");
  });

  it("propagates rejections as values (unknown / not-configured)", async () => {
    const service = createSearchConfigService({ storage: fakeStorage(), registry: REGISTRY });
    expect(await service.updateConfig({ backend: "native" })).toEqual({
      ok: false,
      error: "unknown-backend",
    });
    expect(await service.updateConfig({ backend: "umans" })).toEqual({
      ok: false,
      error: "not-configured",
    });
  });

  it("resolveBackend returns the active backend and null for 'none'", async () => {
    const storage = fakeStorage();
    const service = createSearchConfigService({ storage, registry: REGISTRY });
    expect(await service.resolveBackend()).toBe(firecrawl);
    await service.updateConfig({ backend: "none" });
    expect(await service.resolveBackend()).toBeNull();
  });
});
