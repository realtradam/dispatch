import type { StorageNamespace } from "@dispatch/kernel";
import type { SearchBackend } from "@dispatch/search-backend-contract";
import type { UpdateSearchConfigRequest } from "@dispatch/transport-contract";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../../kernel/src/host/storage.test-support.js";
import {
  applyConfigUpdate,
  availableBackends,
  createSearchConfigService,
  createSearchConfigStore,
  DEFAULT_SEARCH_CONFIG,
  RETIRED_SEARCH_BACKEND_IDS,
  resolveEffectiveBackendId,
  resolveSelectedBackend,
  SEARCH_CONFIG_KEY,
} from "./search-config.js";

function makeBackend(id: string, label = id): SearchBackend {
  return { id, label, search: () => Promise.resolve({ hits: [] }) };
}

const claude = makeBackend("claude", "Claude (native web search)");
const codex = makeBackend("codex", "Codex (native web search)");
const firecrawl = makeBackend("firecrawl", "Firecrawl (self-hosted)");
const other = makeBackend("zeta", "Zeta");

function fakeStorage(initial?: Record<string, string>): StorageNamespace & {
  dump: () => Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
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

describe("resolveEffectiveBackendId", () => {
  it("automatic mode picks claude > codex > firecrawl by registration", () => {
    expect(resolveEffectiveBackendId({}, [firecrawl, codex, claude])).toBe("claude");
    expect(resolveEffectiveBackendId({}, [firecrawl, codex])).toBe("codex");
    expect(resolveEffectiveBackendId({}, [firecrawl])).toBe("firecrawl");
  });

  it("falls back to the first registered backend when none of the order is present", () => {
    expect(resolveEffectiveBackendId({}, [other])).toBe("zeta");
  });

  it("returns 'none' when nothing is registered", () => {
    expect(resolveEffectiveBackendId({}, [])).toBe("none");
  });

  it("an explicit selection wins as-is even when unregistered or 'none'", () => {
    expect(resolveEffectiveBackendId({ backend: "claude" }, [firecrawl])).toBe("claude");
    expect(resolveEffectiveBackendId({ backend: "gone" }, [claude])).toBe("gone");
    expect(resolveEffectiveBackendId({ backend: "none" }, [claude])).toBe("none");
  });
});

describe("resolveSelectedBackend", () => {
  it("resolves the effective backend object", () => {
    expect(resolveSelectedBackend({}, [firecrawl, claude])).toBe(claude);
    expect(resolveSelectedBackend({ backend: "firecrawl" }, [firecrawl, claude])).toBe(firecrawl);
  });

  it("returns null for 'none' and for an unregistered explicit selection", () => {
    expect(resolveSelectedBackend({ backend: "none" }, [claude])).toBeNull();
    expect(resolveSelectedBackend({ backend: "gone" }, [claude])).toBeNull();
  });
});

describe("availableBackends", () => {
  it("lists every backend configured:true, ordered by the default order then registration", () => {
    const list = availableBackends([firecrawl, other, codex, claude]);
    expect(list.map((b) => b.id)).toEqual(["claude", "codex", "firecrawl", "zeta"]);
    expect(list.every((b) => b.configured)).toBe(true);
  });

  it("returns an empty list when nothing is registered", () => {
    expect(availableBackends([])).toEqual([]);
  });
});

describe("applyConfigUpdate", () => {
  it("accepts a registered backend id", () => {
    expect(applyConfigUpdate(DEFAULT_SEARCH_CONFIG, { backend: "codex" }, [codex])).toEqual({
      ok: true,
      config: { backend: "codex" },
    });
  });

  it("accepts the explicit 'none' off state", () => {
    expect(applyConfigUpdate(DEFAULT_SEARCH_CONFIG, { backend: "none" }, [codex])).toEqual({
      ok: true,
      config: { backend: "none" },
    });
  });

  it("rejects an unregistered id as unknown-backend", () => {
    expect(applyConfigUpdate(DEFAULT_SEARCH_CONFIG, { backend: "native" }, [codex])).toEqual({
      ok: false,
      error: "unknown-backend",
    });
  });

  it("rejects an empty / whitespace backend", () => {
    expect(applyConfigUpdate(DEFAULT_SEARCH_CONFIG, { backend: "" }, [codex])).toEqual({
      ok: false,
      error: "unknown-backend",
    });
  });

  it("leaves the current config unchanged when backend is absent", () => {
    expect(
      applyConfigUpdate({ backend: "codex" }, {} as UpdateSearchConfigRequest, [codex]),
    ).toEqual({
      ok: true,
      config: { backend: "codex" },
    });
  });
});

describe("parseConfig via createSearchConfigStore", () => {
  it("treats a persisted retired id ('umans') as absent", async () => {
    const store = createSearchConfigStore(
      fakeStorage({ [SEARCH_CONFIG_KEY]: JSON.stringify({ backend: "umans" }) }),
    );
    expect(await store.get()).toEqual(DEFAULT_SEARCH_CONFIG);
    expect(RETIRED_SEARCH_BACKEND_IDS).toContain("umans");
  });

  it("keeps a valid persisted selection", async () => {
    const store = createSearchConfigStore(
      fakeStorage({ [SEARCH_CONFIG_KEY]: JSON.stringify({ backend: "codex" }) }),
    );
    expect(await store.get()).toEqual({ backend: "codex" });
  });

  it("falls back to the default on garbage", async () => {
    const store = createSearchConfigStore(fakeStorage({ [SEARCH_CONFIG_KEY]: "not-json" }));
    expect(await store.get()).toEqual(DEFAULT_SEARCH_CONFIG);
  });
});

describe("createSearchConfigService", () => {
  it("returns the effective id + availability on first read", async () => {
    const service = createSearchConfigService({
      storage: fakeStorage(),
      listBackends: () => [firecrawl, claude],
    });
    expect(await service.getConfig()).toEqual({
      backend: "claude",
      available: availableBackends([firecrawl, claude]),
    });
  });

  it("persists a valid update under the single global key", async () => {
    const storage = fakeStorage();
    const service = createSearchConfigService({
      storage,
      listBackends: () => [firecrawl, codex],
    });
    const result = await service.updateConfig({ backend: "codex" });
    expect(result).toEqual({ ok: true, config: { backend: "codex" } });
    expect(storage.dump().get(SEARCH_CONFIG_KEY)).toBe(JSON.stringify({ backend: "codex" }));
  });

  it("propagates rejections as values (unknown-backend)", async () => {
    const service = createSearchConfigService({
      storage: fakeStorage(),
      listBackends: () => [codex],
    });
    expect(await service.updateConfig({ backend: "native" })).toEqual({
      ok: false,
      error: "unknown-backend",
    });
  });

  it("resolveBackend returns the active backend and null for 'none'", async () => {
    const storage = fakeStorage();
    const service = createSearchConfigService({
      storage,
      listBackends: () => [firecrawl],
    });
    expect(await service.resolveBackend()).toBe(firecrawl);
    await service.updateConfig({ backend: "none" });
    expect(await service.resolveBackend()).toBeNull();
  });

  it("sees a backend registered after the service was created (list never cached)", async () => {
    const backends: SearchBackend[] = [firecrawl];
    const service = createSearchConfigService({
      storage: fakeStorage(),
      listBackends: () => backends,
    });
    expect((await service.getConfig()).backend).toBe("firecrawl");
    backends.push(claude);
    expect((await service.getConfig()).backend).toBe("claude");
    expect(await service.resolveBackend()).toBe(claude);
  });
});
