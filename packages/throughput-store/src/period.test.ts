import { describe, expect, it } from "vitest";
import { dayKeyOf, resolvePeriod } from "./period.js";

describe("dayKeyOf", () => {
  it("formats a local YYYY-MM-DD key", () => {
    // Build a local-midnight timestamp so the key is timezone-stable.
    const ts = new Date(2026, 5, 10).getTime();
    expect(dayKeyOf(ts)).toBe("2026-06-10");
  });
});

describe("resolvePeriod day", () => {
  it("spans a single local day", () => {
    const r = resolvePeriod("day", "2026-06-10");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dayKeys).toEqual(["2026-06-10"]);
    expect(r.start).toBe(new Date(2026, 5, 10).getTime());
    expect(r.end).toBe(new Date(2026, 5, 11).getTime());
  });

  it("rejects malformed / impossible dates", () => {
    expect(resolvePeriod("day", "2026-13-01").ok).toBe(false);
    expect(resolvePeriod("day", "2026-02-30").ok).toBe(false);
    expect(resolvePeriod("day", "nope").ok).toBe(false);
    expect(resolvePeriod("day", "2026-06").ok).toBe(false);
  });
});

describe("resolvePeriod week", () => {
  it("spans the Monday–Sunday ISO week containing the date", () => {
    const r = resolvePeriod("week", "2026-06-10");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dayKeys).toHaveLength(7);
    // start is a Monday (local)
    expect(new Date(r.start).getDay()).toBe(1);
    // the queried date falls within the week
    expect(r.dayKeys).toContain("2026-06-10");
    // end is exactly 7 local days after start
    expect(new Date(r.end).getDay()).toBe(1);
  });
});

describe("resolvePeriod month", () => {
  it("spans a full calendar month", () => {
    const r = resolvePeriod("month", "2026-06");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dayKeys).toHaveLength(30); // June has 30 days
    expect(r.dayKeys[0]).toBe("2026-06-01");
    expect(r.dayKeys[29]).toBe("2026-06-30");
    expect(r.start).toBe(new Date(2026, 5, 1).getTime());
    expect(r.end).toBe(new Date(2026, 6, 1).getTime());
  });

  it("handles February length", () => {
    const r = resolvePeriod("month", "2026-02");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dayKeys).toHaveLength(28);
  });

  it("rejects a YYYY-MM-DD date for month", () => {
    expect(resolvePeriod("month", "2026-06-10").ok).toBe(false);
  });
});
