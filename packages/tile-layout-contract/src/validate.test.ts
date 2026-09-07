import { describe, expect, it } from "vitest";
import { EMPTY_TILE_LAYOUT } from "./types";
import { isEmptyTileLayoutValid, validateTileLayoutData } from "./validate";

const VALID_DOC = {
  version: 2,
  tiles: [
    { id: "alpha", colSpan: 2, rowSpan: 1, order: 0, col: 1, row: 1 },
    { id: "beta", colSpan: 1, rowSpan: 2, order: 1 },
  ],
};

describe("validateTileLayoutData", () => {
  it("accepts a well-formed document (pinned + flowing tiles)", () => {
    const result = validateTileLayoutData(VALID_DOC);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(VALID_DOC);
    }
  });

  it("accepts the empty document", () => {
    const result = validateTileLayoutData(EMPTY_TILE_LAYOUT);
    expect(result.ok).toBe(true);
  });

  it("rejects non-objects, wrong versions, and missing tile arrays", () => {
    expect(validateTileLayoutData(null).ok).toBe(false);
    expect(validateTileLayoutData("junk").ok).toBe(false);
    expect(validateTileLayoutData([]).ok).toBe(false);
    expect(validateTileLayoutData({ version: 1, tiles: [] }).ok).toBe(false);
    expect(validateTileLayoutData({ version: 2, tiles: "nope" }).ok).toBe(false);
    expect(validateTileLayoutData({ version: 2 }).ok).toBe(false);
  });

  it("rejects junk entries (non-object, empty id, duplicate id)", () => {
    expect(validateTileLayoutData({ version: 2, tiles: [null] }).ok).toBe(false);
    expect(
      validateTileLayoutData({ version: 2, tiles: [{ id: "", colSpan: 1, rowSpan: 1, order: 0 }] })
        .ok,
    ).toBe(false);
    expect(
      validateTileLayoutData({
        version: 2,
        tiles: [
          { id: "a", colSpan: 1, rowSpan: 1, order: 0 },
          { id: "a", colSpan: 1, rowSpan: 1, order: 1 },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateTileLayoutData({ version: 2, tiles: [{ colSpan: 1, rowSpan: 1, order: 0 }] }).ok,
    ).toBe(false);
  });

  it("rejects junk spans and orders", () => {
    const entry = (over: Record<string, unknown>) => ({
      id: "a",
      colSpan: 1,
      rowSpan: 1,
      order: 0,
      ...over,
    });
    expect(validateTileLayoutData({ version: 2, tiles: [entry({ colSpan: 0 })] }).ok).toBe(false);
    expect(validateTileLayoutData({ version: 2, tiles: [entry({ rowSpan: 1.5 })] }).ok).toBe(false);
    expect(validateTileLayoutData({ version: 2, tiles: [entry({ colSpan: "2" })] }).ok).toBe(false);
    expect(validateTileLayoutData({ version: 2, tiles: [entry({ order: -1 })] }).ok).toBe(false);
    expect(validateTileLayoutData({ version: 2, tiles: [entry({ order: Number.NaN })] }).ok).toBe(
      false,
    );
    expect(validateTileLayoutData({ version: 2, tiles: [entry({ colSpan: 65 })] }).ok).toBe(false);
    // Boundary values are fine.
    expect(
      validateTileLayoutData({ version: 2, tiles: [entry({ colSpan: 64, order: 0 })] }).ok,
    ).toBe(true);
  });

  it("rejects lone anchor coordinates and junk anchor values", () => {
    const entry = { id: "a", colSpan: 1, rowSpan: 1, order: 0 };
    expect(validateTileLayoutData({ version: 2, tiles: [{ ...entry, col: 1 }] }).ok).toBe(false);
    expect(validateTileLayoutData({ version: 2, tiles: [{ ...entry, row: 2 }] }).ok).toBe(false);
    expect(validateTileLayoutData({ version: 2, tiles: [{ ...entry, col: 0, row: 1 }] }).ok).toBe(
      false,
    );
    expect(validateTileLayoutData({ version: 2, tiles: [{ ...entry, col: 1, row: 1.5 }] }).ok).toBe(
      false,
    );
    expect(validateTileLayoutData({ version: 2, tiles: [{ ...entry, col: 1, row: 1 }] }).ok).toBe(
      true,
    );
  });
});

describe("isEmptyTileLayoutValid", () => {
  it("is always a valid verdict (self-check)", () => {
    expect(isEmptyTileLayoutValid().ok).toBe(true);
  });
});
