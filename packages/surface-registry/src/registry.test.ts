import type { SurfaceCatalogEntry, SurfaceSpec } from "@dispatch/ui-contract";
import { describe, expect, it } from "vitest";
import type { SurfaceProvider } from "./registry.js";
import { createSurfaceRegistry } from "./registry.js";

function fakeProvider(id: string, title?: string): SurfaceProvider {
  const catalogEntry: SurfaceCatalogEntry = {
    id,
    region: "default",
    title: title ?? `Surface ${id}`,
  };
  return {
    catalogEntry,
    getSpec(): SurfaceSpec {
      return {
        id,
        region: "default",
        title: catalogEntry.title,
        fields: [],
      };
    },
    invoke() {},
  };
}

describe("createSurfaceRegistry", () => {
  describe("register + getCatalog", () => {
    it("returns the entry after registration", () => {
      const registry = createSurfaceRegistry();
      registry.register(fakeProvider("a", "Surface A"));

      const catalog = registry.getCatalog();
      expect(catalog).toHaveLength(1);
      expect(catalog[0]).toEqual({
        id: "a",
        region: "default",
        title: "Surface A",
      });
    });

    it("returns entries for multiple providers", () => {
      const registry = createSurfaceRegistry();
      registry.register(fakeProvider("a"));
      registry.register(fakeProvider("b"));

      const catalog = registry.getCatalog();
      expect(catalog).toHaveLength(2);
      expect(catalog.map((e) => e.id)).toEqual(["a", "b"]);
    });
  });

  describe("getSurface", () => {
    it("returns the provider for a known id", () => {
      const registry = createSurfaceRegistry();
      const provider = fakeProvider("x");
      registry.register(provider);

      expect(registry.getSurface("x")).toBe(provider);
    });

    it("returns undefined for an unknown id", () => {
      const registry = createSurfaceRegistry();
      expect(registry.getSurface("nonexistent")).toBeUndefined();
    });
  });

  describe("disposer", () => {
    it("removes the provider from catalog and lookup", () => {
      const registry = createSurfaceRegistry();
      const dispose = registry.register(fakeProvider("a"));

      expect(registry.getCatalog()).toHaveLength(1);
      expect(registry.getSurface("a")).toBeDefined();

      dispose();

      expect(registry.getCatalog()).toHaveLength(0);
      expect(registry.getSurface("a")).toBeUndefined();
    });

    it("is idempotent — calling dispose twice is safe", () => {
      const registry = createSurfaceRegistry();
      const dispose = registry.register(fakeProvider("a"));

      dispose();
      dispose();

      expect(registry.getCatalog()).toHaveLength(0);
    });

    it("does not remove a replacement provider with the same id", () => {
      const registry = createSurfaceRegistry();
      const first = fakeProvider("a", "First");
      const second = fakeProvider("a", "Second");

      const disposeFirst = registry.register(first);
      registry.register(second);

      disposeFirst();

      // The second provider should still be registered
      expect(registry.getSurface("a")).toBe(second);
      expect(registry.getCatalog()).toHaveLength(1);
      expect(registry.getCatalog()[0]?.title).toBe("Second");
    });
  });

  describe("duplicate-id behavior (last-wins)", () => {
    it("replaces an existing provider when registering the same id", () => {
      const registry = createSurfaceRegistry();
      const first = fakeProvider("a", "First");
      const second = fakeProvider("a", "Second");

      registry.register(first);
      registry.register(second);

      expect(registry.getSurface("a")).toBe(second);
      expect(registry.getCatalog()).toHaveLength(1);
      expect(registry.getCatalog()[0]?.title).toBe("Second");
    });
  });
});
