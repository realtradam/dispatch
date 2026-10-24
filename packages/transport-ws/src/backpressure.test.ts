import { type AgentEvent, createBus, type HostAPI, type Logger } from "@dispatch/kernel";
import {
  type SessionOrchestrator,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import { createSurfaceRegistry, surfaceRegistryHandle } from "@dispatch/surface-registry";
import { afterEach, expect, it, vi } from "vitest";
import { createTransportWsExtension } from "./extension.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(throwOnDispose = false) {
  const warn = vi.fn();
  const logger = { debug() {}, info() {}, warn, error() {} } as unknown as Logger;
  const bus = createBus(logger);
  const registry = createSurfaceRegistry();
  const surfaceDispose = vi.fn();
  registry.register({
    catalogEntry: { id: "test", region: "default", title: "Test" },
    getSpec: () => ({ id: "test", region: "default", title: "Test", fields: [] }),
    invoke() {},
    subscribe: () => surfaceDispose,
  });
  bus.provideService(surfaceRegistryHandle, registry);
  const chatDispose = vi.fn(() => {
    if (throwOnDispose) throw new Error("dispose failed");
  });
  let replay = (_onEvent: (event: AgentEvent) => void) => {};
  const subscribe = vi.fn((_id: string, onEvent: (event: AgentEvent) => void) => {
    replay(onEvent);
    return chatDispose;
  });
  const { promise: queued, resolve: finishQueue } = Promise.withResolvers<{
    startedTurn: boolean;
    queue: [];
  }>();
  bus.provideService(sessionOrchestratorHandle, {
    subscribe,
    enqueue: () => queued,
  } as unknown as SessionOrchestrator);
  let options: Bun.ServeOptions<unknown> | undefined;
  const stop = vi.fn();
  const serve = (opts: Bun.ServeOptions<unknown>) => {
    options = opts;
    return { stop };
  };
  // Bun is non-configurable under Bun itself; fake only the listener edge.
  if (typeof Bun === "undefined") vi.stubGlobal("Bun", { serve });
  else vi.spyOn(Bun, "serve").mockImplementation(serve as typeof Bun.serve);
  const extension = createTransportWsExtension();
  await extension.activate({
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
  } as unknown as HostAPI);
  const handlers = options?.websocket;
  if (!handlers) throw new Error("expected WS callbacks");
  let buffered = 0;
  const send = vi.fn();
  const close = vi.fn();
  const data = {
    subs: new Set<string>(),
    chatSubscriptions: new Map(),
    providerDisposers: new Map(),
  };
  const ws = {
    data,
    send,
    close,
    getBufferedAmount: () => buffered,
  } as unknown as Bun.ServerWebSocket<unknown>;
  handlers.open?.(ws);
  await Promise.resolve(); // initial catalog
  const message = (value: unknown) => handlers.message(ws, JSON.stringify(value));
  await message({ type: "chat.subscribe", conversationId: "c" });
  await message({ type: "subscribe", surfaceId: "test" });
  send.mockClear();
  return {
    data,
    send,
    close,
    warn,
    chatDispose,
    surfaceDispose,
    subscribe,
    stop,
    finishQueue,
    message,
    setBuffered: (value: number) => {
      buffered = value;
    },
    setReplay: (fn: (onEvent: (event: AgentEvent) => void) => void) => {
      replay = fn;
    },
    closeEvent: () => handlers.close?.(ws, 1000, ""),
    deactivate: () => extension.deactivate?.(),
  };
}

it.each([
  0,
  8 * 1024 * 1024,
  8 * 1024 * 1024 + 1,
])("checks the exact 8 MiB limit (%i)", async (bytes) => {
  const f = await fixture();
  try {
    f.setBuffered(bytes);
    await f.message({ type: "chat.send", message: "" });
    if (bytes <= 8 * 1024 * 1024) {
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.close).not.toHaveBeenCalled();
    } else {
      expect(f.send).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledWith(1013, expect.any(String));
      expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("slow consumer"), {
        bufferedBytes: bytes,
      });
      expect(f.chatDispose).toHaveBeenCalledOnce();
      expect(f.surfaceDispose).toHaveBeenCalledOnce();
      await f.message({ type: "chat.send", message: "" });
      expect(f.close).toHaveBeenCalledOnce();
    }
  } finally {
    await f.deactivate();
    f.closeEvent();
  }
  expect(f.chatDispose).toHaveBeenCalledOnce();
  expect(f.surfaceDispose).toHaveBeenCalledOnce();
});

it("closes immediately when a send crosses the limit, including synchronous replay", async () => {
  const f = await fixture();
  try {
    f.send.mockImplementation(() => f.setBuffered(8 * 1024 * 1024 + 1));
    f.setReplay((onEvent) => {
      onEvent({ type: "text-delta", conversationId: "late", turnId: "t", delta: "replay" });
    });
    await f.message({ type: "chat.subscribe", conversationId: "late" });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(f.chatDispose).toHaveBeenCalledTimes(2); // existing + returned replay disposer
    expect(f.data.chatSubscriptions.size).toBe(0);
  } finally {
    await f.deactivate();
  }
});

it.each([
  false,
  true,
])("deactivate disposes subscriptions despite errors (%s); late queue completion cannot resubscribe", async (throwOnDispose) => {
  const f = await fixture(throwOnDispose);
  const pending = f.message({ type: "chat.queue", conversationId: "queued", text: "go" });
  try {
    await f.deactivate();
    expect(f.chatDispose).toHaveBeenCalledOnce();
    expect(f.surfaceDispose).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.chatDispose.mock.invocationCallOrder[0]).toBeLessThan(
      f.stop.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.surfaceDispose.mock.invocationCallOrder[0]).toBeLessThan(
      f.stop.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.data.subs.size + f.data.chatSubscriptions.size + f.data.providerDisposers.size).toBe(
      0,
    );
    f.finishQueue({ startedTurn: true, queue: [] });
    await pending;
    expect(f.subscribe).toHaveBeenCalledOnce();
    f.closeEvent();
    await f.deactivate();
    expect(f.chatDispose).toHaveBeenCalledOnce();
    expect(f.surfaceDispose).toHaveBeenCalledOnce();
  } finally {
    f.finishQueue({ startedTurn: false, queue: [] });
    await pending;
    await f.deactivate();
  }
});
