import { EMPTY_TILE_LAYOUT } from "@dispatch/tile-layout-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeTileLayoutService, tileLayoutStorageKey } from "./service";

/** In-memory StorageNamespace fake (the repo's storage contract, minus keys/has). */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => void map.set(key, value),
    delete: async (key: string) => void map.delete(key),
    has: async (key: string) => map.has(key),
    keys: async () => [...map.keys()],
    map,
  };
}

function deps() {
  const storage = fakeStorage();
  return {
    storage,
    emitChange: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

const DOC = {
  version: 2 as const,
  tiles: [{ id: "alpha", colSpan: 2, rowSpan: 1, order: 0, col: 1, row: 1 }],
};

describe("createHomeTileLayoutService", () => {
  let d: ReturnType<typeof deps>;
  beforeEach(() => {
    d = deps();
  });

  it("seeds a fresh orientation with the empty document (read-through, no event)", async () => {
    const service = createHomeTileLayoutService(d);
    const doc = await service.get("wide");
    expect(doc).toEqual(EMPTY_TILE_LAYOUT);
    expect(d.storage.map.get(tileLayoutStorageKey("wide"))).toBe(JSON.stringify(EMPTY_TILE_LAYOUT));
    expect(d.emitChange).not.toHaveBeenCalled();
  });

  it("keeps orientations independent (one document per mode)", async () => {
    const service = createHomeTileLayoutService(d);
    await service.put("wide", DOC);
    expect(await service.get("tall")).toEqual(EMPTY_TILE_LAYOUT);
    expect(await service.get("wide")).toEqual(DOC);
  });

  it("persists a valid PUT and emits the change exactly once", async () => {
    const service = createHomeTileLayoutService(d);
    const result = await service.put("tall", DOC);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(DOC);
    expect(JSON.parse(d.storage.map.get(tileLayoutStorageKey("tall")) ?? "{}")).toEqual(DOC);
    expect(d.emitChange).toHaveBeenCalledTimes(1);
    expect(d.emitChange).toHaveBeenCalledWith({ type: "tile-layout", mode: "tall", data: DOC });
  });

  it("rejects a junk PUT without persisting or emitting", async () => {
    const service = createHomeTileLayoutService(d);
    const result = await service.put("wide", { version: 7, tiles: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("version");
    expect(d.storage.map.has(tileLayoutStorageKey("wide"))).toBe(false);
    expect(d.emitChange).not.toHaveBeenCalled();
  });

  it("delete re-seeds the empty document and emits it", async () => {
    const service = createHomeTileLayoutService(d);
    await service.put("wide", DOC);
    d.emitChange.mockClear();
    const fresh = await service.delete("wide");
    expect(fresh).toEqual(EMPTY_TILE_LAYOUT);
    expect(d.storage.map.get(tileLayoutStorageKey("wide"))).toBe(JSON.stringify(EMPTY_TILE_LAYOUT));
    expect(d.emitChange).toHaveBeenCalledTimes(1);
    expect(d.emitChange).toHaveBeenCalledWith({
      type: "tile-layout",
      mode: "wide",
      data: EMPTY_TILE_LAYOUT,
    });
  });

  it("re-seeds a corrupt stored record on read", async () => {
    d.storage.map.set(tileLayoutStorageKey("wide"), "not json");
    const service = createHomeTileLayoutService(d);
    expect(await service.get("wide")).toEqual(EMPTY_TILE_LAYOUT);
    expect(d.logger.warn).toHaveBeenCalled();
    expect(d.emitChange).not.toHaveBeenCalled();
  });

  it("re-seeds a wrong-shape stored record on read", async () => {
    d.storage.map.set(tileLayoutStorageKey("wide"), JSON.stringify({ version: 1, root: {} }));
    const service = createHomeTileLayoutService(d);
    expect(await service.get("wide")).toEqual(EMPTY_TILE_LAYOUT);
    expect(d.logger.warn).toHaveBeenCalled();
  });

  it("lets storage failures throw (the route layer maps them to 500)", async () => {
    const service = createHomeTileLayoutService({
      ...d,
      storage: {
        ...d.storage,
        get: async () => {
          throw new Error("db gone");
        },
      },
    });
    await expect(service.get("wide")).rejects.toThrow("db gone");
  });
});
