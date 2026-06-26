import type { StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import type { GitSpawnResult, ResolverAdapters, ResolverFs } from "./resolver.js";
import { createSystemPromptService, DEFAULT_TEMPLATE } from "./service.js";

/** In-memory StorageNamespace for tests. */
function memoryStorage(): StorageNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    has: async (key: string) => store.has(key),
    keys: async (prefix?: string) =>
      [...store.keys()].filter((k) => (prefix === undefined ? true : k.startsWith(prefix))),
  };
}

function fakeFs(files: ReadonlyMap<string, string>): ResolverFs {
  return {
    readText: async (path: string) => files.get(path) ?? "",
    exists: async (path: string) => files.has(path),
  };
}

const failSpawn = async (): Promise<GitSpawnResult> => ({
  stdout: "",
  stderr: "",
  exitCode: 128,
});

function adapters(files: ReadonlyMap<string, string>): ResolverAdapters {
  return {
    spawn: failSpawn,
    fs: fakeFs(files),
    now: () => new Date("2024-06-15T12:30:00.000Z"),
    platform: () => "linux",
    hostname: () => "myhost",
  };
}

describe("system-prompt service", () => {
  it("construct persists and returns the resolved string", async () => {
    // 14. construct writes to storage and returns the resolved string.
    const storage = memoryStorage();
    const service = createSystemPromptService({
      storage,
      adapters: adapters(new Map([["/proj/AGENTS.md", "RULES"]])),
    });

    const result = await service.construct("conv-1", "/proj", { model: "gpt-4" });

    expect(result).toContain("You are a helpful coding assistant.");
    expect(result).toContain("RULES");
    expect(result).toContain("/proj");
    // persisted under resolved:<conversationId>
    expect(await storage.get("resolved:conv-1")).toBe(result);
  });

  it("get returns persisted value after construct", async () => {
    // 15. after construct, get returns the same string.
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map()),
    });

    // before construct → null
    expect(await service.get("conv-2")).toBeNull();

    const result = await service.construct("conv-2", "/proj");
    expect(await service.get("conv-2")).toBe(result);
  });

  it("get returns null before construct", async () => {
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map()),
    });

    expect(await service.get("never-constructed")).toBeNull();
  });

  it("empty/no template stored → default template → non-empty", async () => {
    // 16. no template stored → default template used → resolves to non-empty.
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map()), // no AGENTS.md
    });

    const result = await service.construct("conv-3", "/proj");

    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("You are a helpful coding assistant.");
    expect(result).toContain("/proj");
    // no AGENTS.md file → the [if file:AGENTS.md] block is omitted
    expect(result).not.toContain("AGENTS.md");
  });

  it("stored template is used instead of default", async () => {
    const storage = memoryStorage();
    await storage.set("template", "cwd=[prompt:cwd] os=[system:os]");
    const service = createSystemPromptService({
      storage,
      adapters: adapters(new Map()),
    });

    const result = await service.construct("conv-4", "/work");
    expect(result).toBe("cwd=/work os=linux");
  });

  it("empty stored template → empty string", async () => {
    const storage = memoryStorage();
    await storage.set("template", "");
    const service = createSystemPromptService({
      storage,
      adapters: adapters(new Map()),
    });

    const result = await service.construct("conv-5", "/proj");
    expect(result).toBe("");
    expect(await service.get("conv-5")).toBe("");
  });

  it("construct is independent per conversation", async () => {
    const storage = memoryStorage();
    await storage.set("template", "[prompt:cwd]");
    const service = createSystemPromptService({
      storage,
      adapters: adapters(new Map()),
    });

    const a = await service.construct("conv-a", "/dir-a");
    const b = await service.construct("conv-b", "/dir-b");

    expect(a).toBe("/dir-a");
    expect(b).toBe("/dir-b");
    expect(await service.get("conv-a")).toBe("/dir-a");
    expect(await service.get("conv-b")).toBe("/dir-b");
  });

  it("DEFAULT_TEMPLATE contains the expected structure", () => {
    expect(DEFAULT_TEMPLATE).toContain("You are a helpful coding assistant.");
    expect(DEFAULT_TEMPLATE).toContain("[if file:AGENTS.md]");
    expect(DEFAULT_TEMPLATE).toContain("[file:AGENTS.md]");
    expect(DEFAULT_TEMPLATE).toContain("[prompt:cwd]");
  });

  it("getWithMeta on a never-constructed conversation returns { prompt: null, cwd: null }", async () => {
    // 1. never constructed → both fields null.
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map()),
    });

    const meta = await service.getWithMeta("never-constructed");
    expect(meta).toEqual({ prompt: null, cwd: null, computerId: null });
  });

  it("getWithMeta after construct returns the resolved prompt and the exact cwd", async () => {
    // 2. after construct → prompt + exact cwd passed to construct.
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map([["/proj/AGENTS.md", "RULES"]])),
    });

    const result = await service.construct("conv-meta", "/proj", { model: "gpt-4" });
    const meta = await service.getWithMeta("conv-meta");

    expect(meta.prompt).toBe(result);
    expect(meta.cwd).toBe("/proj");
  });

  it("get still returns the same value as before (backward compat)", async () => {
    // 3. get() behavior is unchanged by the additive getWithMeta.
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map()),
    });

    // before construct → null
    expect(await service.get("conv-bc")).toBeNull();

    const result = await service.construct("conv-bc", "/proj");
    expect(await service.get("conv-bc")).toBe(result);
  });

  it("construct called twice with different cwds stores the latest cwd", async () => {
    // 4. second construct overwrites the cwd (not the first).
    const storage = memoryStorage();
    await storage.set("template", "[prompt:cwd]");
    const service = createSystemPromptService({
      storage,
      adapters: adapters(new Map()),
    });

    await service.construct("conv-twice", "/first");
    expect(await storage.get("resolved-cwd:conv-twice")).toBe("/first");

    const second = await service.construct("conv-twice", "/second");
    expect(second).toBe("/second");
    expect(await storage.get("resolved-cwd:conv-twice")).toBe("/second");
    expect(await storage.get("resolved-cwd:conv-twice")).not.toBe("/first");
  });

  it("getWithMeta after a second construct with a different cwd returns the new cwd and new prompt", async () => {
    // 5. getWithMeta reflects the latest construct, not the first.
    const storage = memoryStorage();
    await storage.set("template", "[prompt:cwd]");
    const service = createSystemPromptService({
      storage,
      adapters: adapters(new Map()),
    });

    const first = await service.construct("conv-second", "/dir-a");
    const firstMeta = await service.getWithMeta("conv-second");
    expect(firstMeta).toEqual({ prompt: first, cwd: "/dir-a", computerId: null });

    const second = await service.construct("conv-second", "/dir-b");
    const secondMeta = await service.getWithMeta("conv-second");
    expect(secondMeta).toEqual({ prompt: second, cwd: "/dir-b", computerId: null });
    expect(secondMeta.cwd).not.toBe("/dir-a");
  });

  // ── resolveText: resolve an arbitrary template (no persistence) ────────────

  it("resolveText substitutes [type:name] variables in an arbitrary template", async () => {
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map()),
    });

    const result = await service.resolveText(
      "os=[system:os] cwd=[prompt:cwd] ws=[prompt:workspace_id] conv=[prompt:conversation_id] model=[prompt:model]",
      "/work",
      { model: "gpt-4", conversationId: "c1", workspaceId: "ws-1" },
    );

    expect(result).toBe("os=linux cwd=/work ws=ws-1 conv=c1 model=gpt-4");
  });

  it("resolveText uses the SAME resolution as construct (same resolver + variables)", async () => {
    // A template resolved via resolveText must equal the same template
    // resolved via construct (both go through the shared resolveTemplate).
    const storage = memoryStorage();
    const template = "os=[system:os] cwd=[prompt:cwd] date=[system:date]";
    await storage.set("template", template);
    const service = createSystemPromptService({
      storage,
      adapters: adapters(new Map()),
    });

    const viaConstruct = await service.construct("conv-rt", "/work");
    const viaResolveText = await service.resolveText(template, "/work");
    expect(viaResolveText).toBe(viaConstruct);
  });

  it("resolveText does NOT persist (unlike construct)", async () => {
    const storage = memoryStorage();
    const service = createSystemPromptService({
      storage,
      adapters: adapters(new Map()),
    });

    await service.resolveText("[prompt:cwd]", "/work", { conversationId: "no-persist" });

    // No resolved:* / resolved-cwd:* / resolved-computer:* keys written.
    expect(await storage.get("resolved:no-persist")).toBeNull();
    expect(await storage.get("resolved-cwd:no-persist")).toBeNull();
    expect(await storage.get("resolved-computer:no-persist")).toBeNull();
  });

  it("resolveText resolves dynamic file:<path> variables referenced by the template", async () => {
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map([["/work/AGENTS.md", "RULES"]])),
    });

    const result = await service.resolveText("[file:AGENTS.md]", "/work");
    expect(result).toBe("RULES");
  });

  it("resolveText handles conditional blocks ([if]/[else]/[endif])", async () => {
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map()),
    });

    // [prompt:model] exists (string) → then-branch renders.
    const withModel = await service.resolveText(
      "[if prompt:model]has model[else]no model[endif]",
      "/work",
      { model: "gpt-4" },
    );
    expect(withModel).toBe("has model");

    // model absent → else-branch renders.
    const noModel = await service.resolveText(
      "[if prompt:model]has model[else]no model[endif]",
      "/work",
    );
    expect(noModel).toBe("no model");
  });

  it("resolveText leaves unknown [type:name] tags substituted as empty (mirrors parser)", async () => {
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map()),
    });

    // An unknown variable (not in the catalog) → empty string, matching
    // parseTemplate's "key absent from the map → empty string" rule.
    const result = await service.resolveText("x=[unknown:thing]", "/work");
    expect(result).toBe("x=");
  });

  it("resolveText on an empty template returns an empty string", async () => {
    const service = createSystemPromptService({
      storage: memoryStorage(),
      adapters: adapters(new Map()),
    });
    expect(await service.resolveText("", "/work")).toBe("");
  });
});
