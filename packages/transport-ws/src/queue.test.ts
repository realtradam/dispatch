import { createBus, type HostAPI, type Logger, runTurn } from "@dispatch/kernel";
import {
  createSessionOrchestrator,
  type EnqueueInput,
  type EnqueueResult,
  type SessionOrchestrator,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import { afterEach, expect, it, vi } from "vitest";
import { createConversationStore } from "../../conversation-store/src/index.js";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createMessageQueueService } from "../../message-queue/src/index.js";
import { createTransportWsExtension } from "./extension.js";

afterEach(() => vi.unstubAllGlobals());

it("WS queue awaits storage, forwards images/computerId, subscribes on start and reports rejection", async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
  const bus = createBus(logger);
  bus.provideService(surfaceRegistryHandle, {
    getCatalog: () => [],
    getSurface: () => undefined,
    register: () => () => {},
  });
  let complete!: (result: EnqueueResult) => void;
  const stored = new Promise<EnqueueResult>((resolve) => {
    complete = resolve;
  });
  const calls: EnqueueInput[] = [];
  const subscribe = vi.fn(() => () => {});
  let rejected = false;
  bus.provideService(sessionOrchestratorHandle, {
    enqueue: (input: EnqueueInput) => {
      calls.push(input);
      return rejected ? Promise.reject(new Error("disk full")) : stored;
    },
    subscribe,
  } as unknown as SessionOrchestrator);
  let options: Bun.ServeOptions<unknown> | undefined;
  const stop = vi.fn();
  vi.stubGlobal("Bun", {
    serve: (opts: Bun.ServeOptions<unknown>) => {
      options = opts;
      return { stop };
    },
  });
  const extension = createTransportWsExtension();
  const host = {
    logger,
    getService: bus.getService,
    tryGetService: bus.tryGetService,
    on: bus.on,
    config: {
      get: (key: string) =>
        key === "networkPolicy"
          ? {
              allowedHosts: new Set(["localhost"]),
              bindAddresses: ["127.0.0.1"],
              tailscaleIps: [],
            }
          : undefined,
    },
    getExtensions: () => [],
  } as unknown as HostAPI;
  const sent: string[] = [];
  const ws = {
    data: { subs: new Set(), chatSubscriptions: new Map(), providerDisposers: new Map() },
    getBufferedAmount: () => 0,
    send: (message: string) => sent.push(message),
  } as unknown as Bun.ServerWebSocket<unknown>;
  const input = {
    type: "chat.queue",
    conversationId: "c",
    text: "",
    computerId: "remote",
    images: [{ url: "data:image/png;base64,AAAA", mimeType: "image/png" }],
  };
  try {
    await extension.activate(host);
    const pending = options?.websocket?.message(ws, JSON.stringify(input));
    expect(calls).toEqual([
      { conversationId: "c", text: "", computerId: input.computerId, images: input.images },
    ]);
    expect(subscribe).not.toHaveBeenCalled();
    complete({ startedTurn: true, queue: [] });
    await pending;
    expect(subscribe).toHaveBeenCalledOnce();
    rejected = true;
    await options?.websocket?.message(ws, JSON.stringify(input));
    expect(sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "chat.error",
      conversationId: "c",
      message: "disk full",
    });
  } finally {
    complete({ startedTurn: false, queue: [] });
    await extension.deactivate?.();
  }
  expect(stop).toHaveBeenCalledOnce();
});

it("WS chat.send acknowledges actual compaction admission, never false already-generating", async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
  const bus = createBus(logger);
  bus.provideService(surfaceRegistryHandle, {
    getCatalog: () => [],
    getSurface: () => undefined,
    register: () => () => {},
  });
  const store = createConversationStore(storageFromMap());
  let id = 0;
  const queue = createMessageQueueService({ id: () => String(++id), now: () => 0, notify() {} });
  const storage = Promise.withResolvers<void>();
  const barrier = Promise.withResolvers<void>();
  const { orchestrator, compacting } = createSessionOrchestrator({
    conversationStore: store,
    resolveQueue: () => queue,
    resolveProvider: () => ({
      id: "fake",
      async *stream() {
        yield { type: "finish", reason: "stop" };
      },
    }),
    resolveTools: () => [],
    applyToolsFilter: async (assembly) => assembly,
    runTurn,
    resolveVisionHandoff: () => ({
      storeImages: async (_id, images) => {
        await storage.promise;
        return images;
      },
      prepareForProvider: async (messages) => messages,
      purgeConversationImages: async () => {},
    }),
  });
  compacting.set("c", barrier.promise);
  bus.provideService(sessionOrchestratorHandle, orchestrator);
  let options: Bun.ServeOptions<unknown> | undefined;
  vi.stubGlobal("Bun", {
    serve: (opts: Bun.ServeOptions<unknown>) => {
      options = opts;
      return { stop() {} };
    },
  });
  const extension = createTransportWsExtension();
  const host = {
    logger,
    getService: bus.getService,
    tryGetService: bus.tryGetService,
    on: bus.on,
    config: {
      get: (key: string) =>
        key === "networkPolicy"
          ? {
              allowedHosts: new Set(["localhost"]),
              bindAddresses: ["127.0.0.1"],
              tailscaleIps: [],
            }
          : undefined,
    },
    getExtensions: () => [],
  } as unknown as HostAPI;
  const sent: unknown[] = [];
  const ws = {
    data: { subs: new Set(), chatSubscriptions: new Map(), providerDisposers: new Map() },
    getBufferedAmount: () => 0,
    send: (message: string) => sent.push(JSON.parse(message)),
  } as unknown as Bun.ServerWebSocket<unknown>;
  const input = {
    type: "chat.send",
    conversationId: "c",
    message: "mine",
    requestId: "request-1",
    images: [{ url: "/images/c/one.png" }],
  };
  try {
    await extension.activate(host);
    const pending = options?.websocket?.message(ws, JSON.stringify(input));
    expect(sent).toEqual([]);
    expect(queue.getQueue("c")).toEqual([]);
    storage.resolve();
    await pending;
    expect(sent).toEqual([
      {
        type: "chat.queued",
        conversationId: "c",
        reason: "compaction",
        messageId: "1",
        requestId: "request-1",
      },
    ]);
    expect(queue.getQueue("c").map((message) => message.text)).toEqual(["mine"]);
    const ended = new Promise<void>((resolve) => {
      const dispose = orchestrator.subscribe("c", (event) => {
        if (event.type === "turn-ended") {
          dispose();
          resolve();
        }
      });
    });
    compacting.delete("c");
    barrier.resolve();
    await ended;
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "chat.delta",
        event: expect.objectContaining({ type: "user-message", text: "mine" }),
      }),
    );
    expect((await store.load("c")).filter((message) => message.role === "user")).toHaveLength(1);
    expect(sent).not.toContainEqual(
      expect.objectContaining({ message: "a turn is already generating for this conversation" }),
    );
  } finally {
    compacting.delete("c");
    storage.resolve();
    barrier.resolve();
    await extension.deactivate?.();
  }
});
