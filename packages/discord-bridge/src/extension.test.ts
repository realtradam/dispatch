import type { ConversationStore } from "@dispatch/conversation-store";
import { conversationDeleted, conversationStoreHandle } from "@dispatch/conversation-store";
import {
  createBus,
  createHost,
  createLogger,
  type Extension,
  type HostAPI,
  type Manifest,
} from "@dispatch/kernel";
import { verifyPlugin } from "@dispatch/plugin-verify";
import {
  conversationClosed,
  type SessionOrchestrator,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import { describe, expect, it } from "vitest";
import {
  createDiscordBridgeExtension,
  extension,
  FELICITY_API_TOKEN,
  FELICITY_API_URL,
  manifest,
  readConfig,
} from "./extension.js";
import { chat, FakeFelicity, FakeOrchestrator, FakeStore, meta } from "./test-support.js";

const base: Omit<Manifest, "id" | "name"> = {
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "core",
  trust: "bundled",
};

/** The dependsOn targets, as in-memory service providers (test environment). */
function environment(orch: FakeOrchestrator, store: FakeStore, onHost?: (h: HostAPI) => void) {
  const orchestratorExt: Extension = {
    manifest: { ...base, id: "session-orchestrator", name: "orchestrator (test)" },
    activate(host) {
      onHost?.(host);
      host.provideService(sessionOrchestratorHandle, orch as unknown as SessionOrchestrator);
    },
  };
  const storeExt: Extension = {
    manifest: { ...base, id: "conversation-store", name: "store (test)" },
    activate(host) {
      host.provideService(conversationStoreHandle, store as unknown as ConversationStore);
    },
  };
  return [orchestratorExt, storeExt];
}

function secrets(values: Record<string, string>) {
  return {
    get: async (k: string) => values[k] ?? null,
    set: async () => {},
    delete: async () => {},
  };
}

describe("discord-bridge extension", () => {
  it("manifest: bundled standard plugin depending only on the orchestrator + store", () => {
    expect(manifest).toMatchObject({
      id: "discord-bridge",
      tier: "standard",
      trust: "bundled",
      dependsOn: ["session-orchestrator", "conversation-store"],
    });
  });

  it("passes verify-plugin when unconfigured (inert)", async () => {
    const report = await verifyPlugin(extension, {
      environment: environment(new FakeOrchestrator(), new FakeStore()),
    });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("passes verify-plugin when ACTIVE (polling, relaying, typing) — nothing dangles", async () => {
    const fake = new FakeFelicity();
    const orch = new FakeOrchestrator();
    const store = new FakeStore();
    store.metas.set("conv-1", meta("conv-1"));
    fake.openChats = [chat("th", "conv-1")];
    orch.active.add("conv-1");
    const ext = createDiscordBridgeExtension({
      resolveConfig: async () => ({ config: { apiUrl: "http://felicity", token: "t" } }),
      createClient: () => fake,
    });
    const report = await verifyPlugin(ext, { environment: environment(orch, store) });
    expect(report.problems).toEqual([]);
    // it really ran: a relay attached (typing lease taken for the active turn)
    expect(fake.ops("typing")[0]).toMatchObject({ active: true });
    // every activation's subscription was released on deactivate
    expect(orch.subscriberCount("conv-1")).toBe(0);
    expect(fake.ops("typing").at(-1)).toMatchObject({ active: false });
  });

  it("wires conversationClosed / conversationDeleted to disconnects", async () => {
    const fake = new FakeFelicity();
    const orch = new FakeOrchestrator();
    const store = new FakeStore();
    store.metas.set("c1", meta("c1"));
    store.metas.set("c2", meta("c2"));
    fake.openChats = [chat("th1", "c1"), chat("th2", "c2")];
    let api: HostAPI | undefined;
    const ext = createDiscordBridgeExtension({
      resolveConfig: async () => ({ config: { apiUrl: "http://felicity", token: "t" } }),
      createClient: () => fake,
    });
    const logger = createLogger(
      { extensionId: "test" },
      { emit: () => {} },
      {
        now: () => 0,
        newId: () => "x",
      },
    );
    const host = createHost([...environment(orch, store, (h) => (api = h)), ext], {
      logger,
      config: { get: () => undefined, getAll: () => ({}) },
      storageFactory: () => {
        throw new Error("no storage in this test");
      },
      secrets: secrets({}),
      permissions: { check: async () => ({ allowed: true }) },
      scheduler: { register: () => {}, unregister: () => {} },
      bus: createBus(logger),
      events: { emit: () => {} },
      logSink: { emit: () => {} },
      logDeps: { now: () => 0, newId: () => "x" },
    });
    await host.activate();
    for (let i = 0; i < 20 && orch.subscriberCount("c2") === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    api?.emit(conversationClosed, { conversationId: "c1" });
    api?.emit(conversationDeleted, { conversationId: "c2" });
    for (let i = 0; i < 20 && fake.ops("disconnect").length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(fake.ops("disconnect")).toEqual([
      { op: "disconnect", threadId: "th1", reason: "conversation_closed" },
      { op: "disconnect", threadId: "th2", reason: "conversation_unavailable" },
    ]);
    await host.deactivate();
  });

  it("readConfig: both secrets required (trimmed); reports what is missing", async () => {
    expect(await readConfig({ secrets: secrets({}) })).toEqual({
      missing: [FELICITY_API_URL, FELICITY_API_TOKEN],
    });
    expect(await readConfig({ secrets: secrets({ [FELICITY_API_URL]: "http://x" }) })).toEqual({
      missing: [FELICITY_API_TOKEN],
    });
    expect(
      await readConfig({
        secrets: secrets({ [FELICITY_API_URL]: " http://x ", [FELICITY_API_TOKEN]: " tok " }),
      }),
    ).toEqual({ config: { apiUrl: "http://x", token: "tok" } });
  });
});
