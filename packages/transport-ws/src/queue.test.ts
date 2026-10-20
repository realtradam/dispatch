import { createBus, type HostAPI, type Logger } from "@dispatch/kernel";
import {
  type EnqueueInput,
  type EnqueueResult,
  type SessionOrchestrator,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import { afterEach, expect, it, vi } from "vitest";
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
