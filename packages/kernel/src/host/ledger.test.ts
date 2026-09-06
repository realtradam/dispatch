import { describe, expect, it } from "vitest";
import { ExtensionLedger } from "./ledger.js";

function createSpy() {
  let calls = 0;
  return {
    fn: () => {
      calls++;
    },
    count: () => calls,
  };
}

describe("ExtensionLedger", () => {
  describe("plain registrations", () => {
    it("tracks a tool under the right extension id", () => {
      const ledger = new ExtensionLedger();
      ledger.trackTool("a", "tool-one");
      expect(ledger.has("a")).toBe(true);
      expect(ledger.getEntry("a")?.tools).toEqual(["tool-one"]);
    });

    it("tracks providers, auth, and jobs under the right kinds", () => {
      const ledger = new ExtensionLedger();
      ledger.trackProvider("a", "provider-x");
      ledger.trackAuth("a", "auth-y");
      ledger.trackJob("a", "job-z");
      const entry = ledger.getEntry("a");
      expect(entry?.providers).toEqual(["provider-x"]);
      expect(entry?.auth).toEqual(["auth-y"]);
      expect(entry?.jobs).toEqual(["job-z"]);
    });

    it("keeps different extension ids isolated", () => {
      const ledger = new ExtensionLedger();
      ledger.trackTool("a", "tool-a");
      ledger.trackTool("b", "tool-b");
      expect(ledger.getEntry("a")?.tools).toEqual(["tool-a"]);
      expect(ledger.getEntry("b")?.tools).toEqual(["tool-b"]);
    });

    it("accumulates multiple registrations of the same kind", () => {
      const ledger = new ExtensionLedger();
      ledger.trackTool("a", "t1");
      ledger.trackTool("a", "t2");
      expect(ledger.getEntry("a")?.tools).toEqual(["t1", "t2"]);
    });

    it("returns undefined for an unknown extension", () => {
      const ledger = new ExtensionLedger();
      expect(ledger.has("ghost")).toBe(false);
      expect(ledger.getEntry("ghost")).toBeUndefined();
    });
  });

  describe("tracked disposals", () => {
    it("tracks services, subscriptions, and filters with the wrapped disposer", () => {
      const ledger = new ExtensionLedger();
      const raw = createSpy();
      const d1 = ledger.trackDisposal("a", "service", "svc/handle", raw.fn);
      const d2 = ledger.trackDisposal("a", "subscription", "evt/hook", raw.fn);
      const d3 = ledger.trackDisposal("a", "filter", "filter/hook", raw.fn);
      const entry = ledger.getEntry("a");
      expect(entry?.disposals.map((d) => d.kind)).toEqual(["service", "subscription", "filter"]);
      expect(entry?.disposals[0]?.id).toBe("svc/handle");
      // the wrapped disposers are the ones handed to the extension
      expect(d1).toBe(entry?.disposals[0]?.dispose);
      expect(d2).toBe(entry?.disposals[1]?.dispose);
      expect(d3).toBe(entry?.disposals[2]?.dispose);
    });

    it("marks a registration disposed when the wrapped disposer is called", () => {
      const ledger = new ExtensionLedger();
      const raw = createSpy();
      const dispose = ledger.trackDisposal("a", "service", "svc/handle", raw.fn);
      const entry = ledger.getEntry("a");
      expect(entry?.disposals[0]?.isDisposed()).toBe(false);
      dispose();
      expect(entry?.disposals[0]?.isDisposed()).toBe(true);
      expect(raw.count()).toBe(1);
    });

    it("dispose-twice is a no-op (raw disposer runs once)", () => {
      const ledger = new ExtensionLedger();
      const raw = createSpy();
      const dispose = ledger.trackDisposal("a", "filter", "f/hook", raw.fn);
      dispose();
      dispose();
      dispose();
      expect(raw.count()).toBe(1);
    });

    it("an undisposed registration still reports undisposed", () => {
      const ledger = new ExtensionLedger();
      ledger.trackDisposal("a", "subscription", "e/hook", () => {});
      expect(ledger.getEntry("a")?.disposals[0]?.isDisposed()).toBe(false);
    });
  });

  describe("job untracking", () => {
    it("untrackJob forgets the job registration", () => {
      const ledger = new ExtensionLedger();
      ledger.trackJob("a", "job-1");
      ledger.untrackJob("a", "job-1");
      expect(ledger.getEntry("a")?.jobs).toEqual([]);
    });

    it("untrackJob for an unknown extension or job is a no-op", () => {
      const ledger = new ExtensionLedger();
      expect(() => ledger.untrackJob("ghost", "nope")).not.toThrow();
      ledger.trackJob("a", "job-1");
      expect(() => ledger.untrackJob("a", "other")).not.toThrow();
      expect(ledger.getEntry("a")?.jobs).toEqual(["job-1"]);
    });
  });

  describe("remove", () => {
    it("drops the entry entirely", () => {
      const ledger = new ExtensionLedger();
      ledger.trackTool("a", "t1");
      ledger.trackDisposal("a", "service", "svc", () => {});
      ledger.remove("a");
      expect(ledger.has("a")).toBe(false);
      expect(ledger.getEntry("a")).toBeUndefined();
    });
  });
});
