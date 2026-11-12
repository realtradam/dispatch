import type { SearchBackend } from "@dispatch/search-backend-contract";
import { describe, expect, it } from "vitest";
import { createSearchBackendRegistry } from "./registry.js";

function makeBackend(id: string): SearchBackend {
  return { id, label: `Label ${id}`, search: () => Promise.resolve({ hits: [] }) };
}

describe("createSearchBackendRegistry", () => {
  it("registers backends and lists them in registration order", () => {
    const instance = createSearchBackendRegistry();
    const a = makeBackend("a");
    const b = makeBackend("b");
    instance.registry.register(a);
    instance.registry.register(b);
    expect(instance.list()).toEqual([a, b]);
  });

  it("throws when the same id is registered twice", () => {
    const instance = createSearchBackendRegistry();
    instance.registry.register(makeBackend("dup"));
    expect(() => instance.registry.register(makeBackend("dup"))).toThrow(
      'Search backend "dup" is already registered.',
    );
  });

  it("the disposer removes only its own registration", () => {
    const instance = createSearchBackendRegistry();
    const a = makeBackend("a");
    const b = makeBackend("b");
    const disposeA = instance.registry.register(a);
    instance.registry.register(b);
    disposeA();
    expect(instance.list()).toEqual([b]);
  });

  it("the disposer is idempotent and never removes a later registration", () => {
    const instance = createSearchBackendRegistry();
    const disposeA = instance.registry.register(makeBackend("a"));
    disposeA();
    const a2 = makeBackend("a");
    instance.registry.register(a2);
    disposeA(); // idempotent no-op — must not remove a2
    expect(instance.list()).toEqual([a2]);
  });
});
