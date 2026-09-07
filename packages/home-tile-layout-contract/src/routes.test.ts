import { EMPTY_TILE_LAYOUT } from "@dispatch/tile-layout-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTileLayoutRouteHandlers, parseTileLayoutBody } from "./routes";
import { createHomeTileLayoutService } from "./service";

function makeService() {
  return createHomeTileLayoutService({
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      has: async () => false,
      keys: async () => [],
    },
    emitChange: () => {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
}

describe("createTileLayoutRouteHandlers", () => {
  let service: ReturnType<typeof makeService> | undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const handlers = () => createTileLayoutRouteHandlers({ getService: async () => service, logger });

  beforeEach(() => {
    service = makeService();
  });

  it("GET returns the orientation's document (200)", async () => {
    const result = await handlers().get("wide");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ layout: EMPTY_TILE_LAYOUT });
  });

  it("PUT with a valid body persists and returns it (200)", async () => {
    const doc = { version: 2 as const, tiles: [{ id: "a", colSpan: 1, rowSpan: 1, order: 0 }] };
    const result = await handlers().put("tall", { layout: doc });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ layout: doc });
  });

  it("PUT with a junk body is a 400 that names the problem", async () => {
    const result = await handlers().put("wide", { layout: { version: 1, tiles: [] } });
    expect(result.status).toBe(400);
    if (!("layout" in result.body)) expect(result.body.error).toContain("version");
  });

  it("every route rejects an unknown mode with 400", async () => {
    expect((await handlers().get("diagonal")).status).toBe(400);
    expect((await handlers().put("portrait", { layout: EMPTY_TILE_LAYOUT })).status).toBe(400);
    expect((await handlers().delete("")).status).toBe(400);
  });

  it("degrades to 503 while the service is absent", async () => {
    service = undefined;
    expect((await handlers().get("wide")).status).toBe(503);
    expect((await handlers().put("wide", { layout: EMPTY_TILE_LAYOUT })).status).toBe(503);
    expect((await handlers().delete("wide")).status).toBe(503);
  });

  it("maps a storage failure to 500", async () => {
    service = {
      get: async () => {
        throw new Error("boom");
      },
      put: async () => {
        throw new Error("boom");
      },
      delete: async () => {
        throw new Error("boom");
      },
    };
    expect((await handlers().get("wide")).status).toBe(500);
    expect((await handlers().delete("wide")).status).toBe(500);
  });
});

describe("parseTileLayoutBody", () => {
  it("accepts { layout } and rejects non-objects and junk layouts", () => {
    const doc = { version: 2 as const, tiles: [] };
    expect(parseTileLayoutBody({ layout: doc })).toEqual({ ok: true, data: doc });
    expect(parseTileLayoutBody(null).ok).toBe(false);
    expect(parseTileLayoutBody("junk").ok).toBe(false);
    expect(parseTileLayoutBody({ layout: null }).ok).toBe(false);
    expect(parseTileLayoutBody({}).ok).toBe(false);
  });
});
