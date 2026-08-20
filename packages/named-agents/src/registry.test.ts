import type { StorageNamespace } from "@dispatch/kernel";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createNamedAgentsService, type NamedAgentsDeps } from "./registry.js";

/** In-memory StorageNamespace fake — the injected storage edge, not a mock. */
function memoryStorage(): StorageNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    has: async (key) => store.has(key),
    keys: async (prefix) =>
      [...store.keys()].filter((k) => (prefix === undefined ? true : k.startsWith(prefix))),
  };
}

/** Deterministic sequential id factory for stable test ids. */
function seqId(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe("named-agents registry", () => {
  it("create then list round-trips; list is sorted by normalized name", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    await service.create({ name: "Zeta", model: "umans/z-1" });
    await service.create({ name: "Alpha", model: "umans/a-1" });

    const all = await service.list();
    expect(all).toHaveLength(2);
    expect(all[0]?.name).toBe("Alpha");
    expect(all[1]?.name).toBe("Zeta");
  });

  it("generates a stable id on create and get returns the canonical record", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    const created = await service.create({ name: "Coding Agent", model: "umans/u-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.agent.id).toBe("id-1");

    const got = await service.get("id-1");
    expect(got).toEqual(created.agent);
  });

  it("create normalizes the stored name (trim + collapse whitespace)", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    const created = await service.create({ name: "  Coding   Agent  ", model: "umans/u-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.agent.name).toBe("Coding Agent");
  });

  it("update targets by id and returns the canonical saved record", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    const created = await service.create({ name: "Coding", model: "umans/u-1" });
    if (!created.ok) throw new Error("create failed");

    const updated = await service.update(created.agent.id, {
      name: "Coding Agent",
      model: "opencode-1/claude-sonnet-4.5",
    });
    expect(updated).toEqual({
      ok: true,
      agent: {
        id: created.agent.id,
        name: "Coding Agent",
        model: "opencode-1/claude-sonnet-4.5",
      },
    });

    const got = await service.get(created.agent.id);
    expect(got?.model).toBe("opencode-1/claude-sonnet-4.5");
    expect(got?.name).toBe("Coding Agent");
  });

  it("delete removes a record; a subsequent get is null", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    const created = await service.create({ name: "Coding", model: "umans/u-1" });
    if (!created.ok) throw new Error("create failed");

    const removed = await service.delete(created.agent.id);
    expect(removed).toEqual({ ok: true, id: created.agent.id });
    expect(await service.get(created.agent.id)).toBeNull();
    expect(await service.list()).toHaveLength(0);
  });

  it("rejects a duplicate name on create (case-insensitive)", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    await service.create({ name: "Coding Agent", model: "umans/u-1" });

    const dup = await service.create({ name: "coding agent", model: "opencode-1/x" });
    expect(dup).toEqual({ ok: false, error: "duplicate-name" });
    expect(await service.list()).toHaveLength(1);
  });

  it("rejects a duplicate name on update but allows keeping its own name", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    const a = await service.create({ name: "Coding", model: "umans/u-1" });
    const b = await service.create({ name: "Research", model: "umans/u-2" });
    if (!a.ok || !b.ok) throw new Error("create failed");

    // Renaming A to B's name (case-insensitive) is a conflict.
    const conflict = await service.update(a.agent.id, { name: "research", model: "umans/u-1" });
    expect(conflict).toEqual({ ok: false, error: "duplicate-name" });

    // Keeping its own name (with a model change) is allowed — self is excluded.
    const kept = await service.update(a.agent.id, { name: "Coding", model: "opencode-1/x" });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.agent.name).toBe("Coding");
    expect(kept.agent.model).toBe("opencode-1/x");
  });

  it("validates required name (empty/whitespace -> invalid-name)", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    expect(await service.create({ name: "", model: "umans/u-1" })).toEqual({
      ok: false,
      error: "invalid-name",
    });
    expect(await service.create({ name: "   ", model: "umans/u-1" })).toEqual({
      ok: false,
      error: "invalid-name",
    });
    expect(await service.list()).toHaveLength(0);
  });

  it("validates required model (missing slash / empty side -> invalid-model)", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    expect(await service.create({ name: "Coding", model: "no-slash" })).toEqual({
      ok: false,
      error: "invalid-model",
    });
    expect(await service.create({ name: "Coding", model: "umans/" })).toEqual({
      ok: false,
      error: "invalid-model",
    });
    expect(await service.create({ name: "Coding", model: "/model" })).toEqual({
      ok: false,
      error: "invalid-model",
    });
    expect(await service.list()).toHaveLength(0);
  });

  it("resolve looks up by stable id and by case-insensitive name", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    const created = await service.create({ name: "Coding Agent", model: "umans/u-1" });
    if (!created.ok) throw new Error("create failed");
    const { id } = created.agent;

    expect((await service.resolve(id))?.name).toBe("Coding Agent");
    expect((await service.resolve("coding agent"))?.id).toBe(id);
    expect((await service.resolve("CODING AGENT"))?.id).toBe(id);
    expect(await service.resolve("missing")).toBeNull();
  });

  it("getByName is a case-insensitive normalized name lookup", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    const created = await service.create({ name: "Coding Agent", model: "umans/u-1" });
    if (!created.ok) throw new Error("create failed");

    expect((await service.getByName("coding agent"))?.id).toBe(created.agent.id);
    expect((await service.getByName("  CODING   AGENT  "))?.id).toBe(created.agent.id);
    expect(await service.getByName("missing")).toBeNull();
  });

  it("returns not-found for an unknown id on update/delete/get", async () => {
    const service = createNamedAgentsService(memoryStorage(), { generateId: seqId() });
    expect(await service.update("nope", { name: "X", model: "umans/u-1" })).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(await service.delete("nope")).toEqual({ ok: false, error: "not-found", id: "nope" });
    expect(await service.get("nope")).toBeNull();
  });

  it("defaults generateId to crypto.randomUUID when deps omit it", async () => {
    const service = createNamedAgentsService(memoryStorage());
    const created = await service.create({ name: "Coding", model: "umans/u-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // A UUID v4 is 36 chars with 4 hyphens.
    expect(created.agent.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect((await service.get(created.agent.id))?.id).toBe(created.agent.id);
  });

  it("deps expose no provider-catalog dependency (by design)", () => {
    // The registry never imports credential-store or calls listCatalog/
    // getModelInfo. Asserted at the type level: NamedAgentsDeps carries only
    // an id factory (+ reserved clock) — no catalog handle of any kind.
    expectTypeOf<NamedAgentsDeps>().toEqualTypeOf<{
      readonly generateId?: () => string;
      readonly now?: () => number;
    }>();
  });
});
