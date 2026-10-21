import { type AgentEvent, createBus, type HostAPI, type Logger, runTurn } from "@dispatch/kernel";
import {
  compactReplay,
  createSessionOrchestrator,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import { createSurfaceRegistry, surfaceRegistryHandle } from "@dispatch/surface-registry";
import { afterEach, expect, it, vi } from "vitest";
import { createConversationStore } from "../../conversation-store/src/index.js";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createTransportWsExtension } from "./extension.js";

function gate() {
  return Promise.withResolvers<void>();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture(
  large = true,
  many = false,
  liveLarge = false,
  options: { calls?: number; inputBytes?: number; livePayloadBytes?: number } = {},
) {
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
  const bus = createBus(logger);
  const registry = createSurfaceRegistry();
  let notify = () => {};
  let surfaceDisposals = 0;
  registry.register({
    catalogEntry: { id: "test", region: "default", title: "Test" },
    getSpec: () => ({ id: "test", region: "default", title: "Test", fields: [] }),
    invoke() {},
    subscribe(listener) {
      notify = listener;
      return () => surfaceDisposals++;
    },
  });
  bus.provideService(surfaceRegistryHandle, registry);
  const ready = gate();
  const release = gate();
  const store = createConversationStore(storageFromMap());
  const payload =
    options.livePayloadBytes !== undefined
      ? "x".repeat(options.livePayloadBytes)
      : large
        ? "x".repeat(9 * 1024 * 1024)
        : "small";
  let step = 0;
  const { orchestrator } = createSessionOrchestrator({
    conversationStore: store,
    resolveProvider: () => ({
      id: "fixture",
      async *stream() {
        if (step++ === 0) {
          if (many || options.calls !== undefined) {
            for (let i = 0; i < (options.calls ?? 5000); i++)
              yield {
                type: "tool-call",
                toolCallId: `many-${i}`,
                toolName: "echo",
                input: { payload: "x".repeat(options.inputBytes ?? 2048) },
              };
          }
          yield { type: "tool-call", toolCallId: "call", toolName: "echo", input: { payload } };
          yield { type: "finish", reason: "tool-calls" };
        } else {
          ready.resolve();
          await release.promise;
          if (liveLarge) yield { type: "text-delta", delta: "z".repeat(9 * 1024 * 1024) };
          yield { type: "text-delta", delta: "live tail" };
          yield { type: "finish", reason: "stop" };
        }
      },
    }),
    resolveTools: () => [
      {
        name: "echo",
        description: "fixture",
        parameters: { type: "object" },
        concurrencySafe: true,
        execute: async () => ({ content: payload }),
      },
    ],
    applyToolsFilter: async (assembly) => assembly,
    runTurn,
  });
  let chatDisposals = 0;
  const subscribe = orchestrator.subscribe;
  orchestrator.subscribe = (...args) => {
    const dispose = subscribe(...args);
    return () => {
      chatDisposals++;
      dispose();
    };
  };
  bus.provideService(sessionOrchestratorHandle, orchestrator);
  let serveOptions: Bun.ServeOptions<unknown> | undefined;
  vi.stubGlobal("Bun", {
    serve: (opts: Bun.ServeOptions<unknown>) => {
      serveOptions = opts;
      return { stop() {} };
    },
  });
  const extension = createTransportWsExtension();
  await extension.activate({
    logger,
    getService: bus.getService,
    tryGetService: bus.tryGetService,
    on: bus.on,
    getExtensions: () => [],
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
  } as unknown as HostAPI);
  const handlers = serveOptions?.websocket;
  if (!handlers) throw new Error("missing handlers");
  let buffered = 0;
  let peak = 0;
  let transmitted = 0;
  const sent: string[] = [];
  const close = vi.fn();
  const ws = {
    data: { subs: new Set(), chatSubscriptions: new Map(), providerDisposers: new Map() },
    getBufferedAmount: () => buffered,
    close,
    send(message: string) {
      buffered += Buffer.byteLength(message);
      peak = Math.max(peak, buffered);
      transmitted += Buffer.byteLength(message);
      sent.push(message);
      return -1; // Bun -1: accepted into its socket buffer; never resend it.
    },
  } as unknown as Bun.ServerWebSocket<unknown>;
  const message = (value: unknown) => handlers.message(ws, JSON.stringify(value));
  handlers.open?.(ws);
  await Promise.resolve();
  const events: AgentEvent[] = [];
  const ended = gate();
  const dispose = orchestrator.subscribe("c", (event) => {
    events.push(event);
    if (event.type === "turn-ended") ended.resolve();
  });
  if (options.livePayloadBytes !== undefined)
    await message({ type: "chat.subscribe", conversationId: "c" });
  orchestrator.startTurn({ conversationId: "c", text: "run" });
  await ready.promise;
  return {
    orchestrator,
    registry,
    store,
    events,
    sent,
    close,
    message,
    notify: () => notify(),
    release: () => release.resolve(),
    ended: ended.promise,
    buffered: () => buffered,
    setBuffered: (bytes: number) => {
      buffered = bytes;
    },
    drain: () => {
      buffered = 0;
    },
    progress: () => {
      buffered = Math.max(0, buffered - 1);
    },
    peak: () => peak,
    transmitted: () => transmitted,
    disposals: () => ({ chat: chatDisposals, surface: surfaceDisposals }),
    async cleanup() {
      release.resolve();
      await ended.promise;
      dispose();
      await extension.deactivate?.();
    },
  };
}

it("late join above 8 MiB converges to live without closing; full committed payloads survive", async () => {
  const f = await fixture();
  try {
    const replayBytes = f.events.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
      0,
    );
    expect(replayBytes).toBeGreaterThan(18 * 1024 * 1024);
    await f.message({ type: "chat.subscribe", conversationId: "c" });
    console.info(
      JSON.stringify({
        fixture: "BE-4 join boundary",
        replayBytes,
        peakBufferedBytes: f.peak(),
        closes: f.close.mock.calls.length,
      }),
    );
    expect(f.close).not.toHaveBeenCalled();
    const packets = f.sent.map((message) => JSON.parse(message));
    expect(packets).toContainEqual({
      type: "chat.resync-required",
      conversationId: "c",
      turnId: expect.any(String),
      reason: "replay-limit",
    });
    expect(packets.filter((message) => message.type === "chat.delta")).toEqual([]);
    await f.message({ type: "subscribe", surfaceId: "test" });
    f.notify();
    // Another conversation and a surface can still use this same connection.
    await f.message({ type: "chat.subscribe", conversationId: "other" });
    f.orchestrator.startTurn({ conversationId: "other", text: "other" });
    f.release();
    await f.ended;
    await vi.waitFor(() =>
      expect(f.sent.some((message) => message.includes("live tail"))).toBe(true),
    );
    expect(f.close).not.toHaveBeenCalled();
    expect(f.sent.map((message) => JSON.parse(message).type)).toContain("update");
    expect(f.sent.some((message) => message.includes('"conversationId":"other"'))).toBe(true);
    const chunks = (await f.store.load("c")).flatMap((message) => message.chunks);
    expect(chunks.find((chunk) => chunk.type === "tool-call")).toMatchObject({
      input: { payload: "x".repeat(9 * 1024 * 1024) },
    });
    expect(chunks.find((chunk) => chunk.type === "tool-result")).toMatchObject({
      content: "x".repeat(9 * 1024 * 1024),
    });
    expect(f.peak()).toBeLessThan(256 * 1024);
    console.info(
      JSON.stringify({
        fixture: "BE-4 late join",
        replayBytes,
        peakBufferedBytes: f.peak(),
        transmittedBytes: f.transmitted(),
        closes: f.close.mock.calls.length,
      }),
    );
  } finally {
    await f.cleanup();
  }
});

it("small replay is complete and a draining consumer stays connected", async () => {
  vi.useFakeTimers();
  const f = await fixture(false);
  try {
    await f.message({ type: "chat.subscribe", conversationId: "c" });
    expect(
      f.sent
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === "chat.delta")
        .map((message) => message.event),
    ).toEqual(compactReplay(f.events));
    f.drain();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(f.close).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it("stalled consumers below the byte limit are disposed without waiting for another send", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  try {
    await f.message({ type: "subscribe", surfaceId: "test" });
    await f.message({ type: "chat.subscribe", conversationId: "c" });
    expect(f.buffered()).toBeLessThan(8 * 1024 * 1024);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(1013, expect.stringContaining("Stalled"));
    expect(f.disposals()).toEqual({ chat: 1, surface: 1 });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it("thousands of small retained events exceed 8 MiB but never form a replay burst", async () => {
  const f = await fixture(false, true);
  try {
    const replayBytes = f.events.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
      0,
    );
    expect(replayBytes).toBeGreaterThan(8 * 1024 * 1024);
    await f.message({ type: "chat.subscribe", conversationId: "c" });
    expect(f.sent.map((message) => JSON.parse(message).type)).toEqual([
      "catalog",
      "chat.resync-required",
    ]);
    f.release();
    await f.ended;
    expect(f.close).not.toHaveBeenCalled();
    expect(f.sent.some((message) => message.includes("live tail"))).toBe(true);
    expect(f.peak()).toBeLessThan(256 * 1024);
    console.info(
      JSON.stringify({
        fixture: "BE-4 many events",
        replayBytes,
        peakBufferedBytes: f.peak(),
        transmittedBytes: f.transmitted(),
      }),
    );
  } finally {
    await f.cleanup();
  }
});

it("oversized live events also request resync rather than forcing a replay/reconnect cycle", async () => {
  const f = await fixture(false, false, true);
  try {
    await f.message({ type: "chat.subscribe", conversationId: "c" });
    f.release();
    await f.ended;
    expect(f.close).not.toHaveBeenCalled();
    expect(f.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "chat.resync-required",
      conversationId: "c",
      turnId: expect.any(String),
      reason: "payload-limit",
    });
    expect(f.sent.some((message) => message.includes("live tail"))).toBe(true);
    expect(f.peak()).toBeLessThan(256 * 1024);
  } finally {
    await f.cleanup();
  }
});

it("repeated normal subscribes cannot use replay to exceed the shared socket headroom", async () => {
  const f = await fixture(false);
  try {
    // Each replay fits on its own; the aggregate crosses the shared 6 MiB
    // watermark and must use notices instead of growing to the 8 MiB close.
    const opening = "x".repeat(100_000);
    for (let i = 0; i < 80; i++) {
      const id = `repeat-${i}`;
      f.orchestrator.startTurn({ conversationId: id, text: opening });
      await f.message({ type: "chat.subscribe", conversationId: id });
    }
    expect(f.peak()).toBeLessThanOrEqual(6 * 1024 * 1024 + 80 * 256);
    expect(f.sent.some((message) => message.includes("replay-limit"))).toBe(true);
    expect(f.close).not.toHaveBeenCalled();
    f.release();
    await f.ended;
  } finally {
    await f.cleanup();
  }
});

it("a slowly progressing consumer gets a fresh stall deadline", async () => {
  vi.useFakeTimers();
  const f = await fixture(false);
  try {
    await f.message({ type: "chat.subscribe", conversationId: "c" });
    for (let i = 0; i < 8; i++) {
      f.progress();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(f.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it("deactivate cancels the stall watchdog and disposes subscriptions exactly once", async () => {
  vi.useFakeTimers();
  const f = await fixture(false);
  await f.message({ type: "subscribe", surfaceId: "test" });
  await f.message({ type: "chat.subscribe", conversationId: "c" });
  expect(vi.getTimerCount()).toBe(1);
  await f.cleanup();
  expect(vi.getTimerCount()).toBe(0);
  expect(f.disposals()).toEqual({ chat: 2, surface: 1 }); // includes fixture observer
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.close).not.toHaveBeenCalled();
});

it("bounds subscription metadata across chat and surface subscriptions", async () => {
  const f = await fixture(false);
  try {
    await f.message({ type: "subscribe", surfaceId: "test" });
    for (let i = 0; i < 255; i++) {
      await f.message({ type: "chat.subscribe", conversationId: `idle-${i}` });
    }
    expect(f.close).not.toHaveBeenCalled();
    await f.message({ type: "chat.subscribe", conversationId: "over-limit" });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "chat.subscription-rejected",
      conversationId: "over-limit",
      reason: "subscription-limit",
    });
    expect(f.disposals()).toEqual({ chat: 0, surface: 0 });
    // A rejected watcher must never gate input admission, even on the same socket.
    await f.message({
      type: "chat.send",
      conversationId: "at-cap",
      message: "keep this",
      requestId: "receipt",
    });
    await vi.waitFor(() =>
      expect(f.sent.map((message) => JSON.parse(message))).toContainEqual({
        type: "chat.accepted",
        conversationId: "at-cap",
        requestId: "receipt",
      }),
    );
    expect((await f.store.load("at-cap"))[0]).toMatchObject({
      role: "user",
      chunks: [{ type: "text", text: "keep this" }],
    });
    // Freeing a slot makes the previously rejected watcher usable again.
    await f.message({ type: "chat.unsubscribe", conversationId: "idle-0" });
    const before = f.sent.length;
    await f.message({ type: "chat.subscribe", conversationId: "over-limit" });
    expect(f.sent.slice(before).some((message) => message.includes("subscription-rejected"))).toBe(
      false,
    );
  } finally {
    await f.cleanup();
  }
});

it("unchanged synchronous omitted callback can reenter live delivery without a gap", async () => {
  const f = await fixture();
  try {
    const received: AgentEvent[] = [];
    const omitted: string[] = [];
    const dispose = f.orchestrator.subscribe("c", (event) => received.push(event), {
      replay: {
        maxEvents: 0,
        accept: () => false,
        onOmitted(turnId) {
          omitted.push(turnId);
          f.release();
        },
      },
    });
    try {
      await f.ended;
      expect(omitted).toHaveLength(1);
      expect(
        received.some((event) => event.type === "text-delta" && event.delta === "live tail"),
      ).toBe(true);
      expect(received.filter((event) => event.type === "turn-ended")).toHaveLength(1);
      expect(received.some((event) => event.type === "tool-result")).toBe(false);
    } finally {
      dispose();
    }
  } finally {
    await f.cleanup();
  }
});

it("continuous draining traffic with a stable backlog is not classified as stuck", async () => {
  vi.useFakeTimers();
  const f = await fixture(false);
  try {
    await f.message({ type: "subscribe", surfaceId: "test" });
    const backlog = f.buffered();
    for (let i = 0; i < 10; i++) {
      f.notify();
      f.setBuffered(backlog); // exactly the newly sent bytes drained
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(f.close).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it("oversized surface payloads cannot allocate unbounded frames or disconnect other subscriptions", async () => {
  const f = await fixture(false);
  try {
    f.registry.register({
      catalogEntry: { id: "huge", title: "Huge", region: "default" },
      getSpec: () => ({
        id: "huge",
        title: "x".repeat(9 * 1024 * 1024),
        region: "default",
        fields: [],
      }),
      invoke() {},
    });
    await f.message({ type: "subscribe", surfaceId: "huge" });
    expect(f.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "error",
      message: "WebSocket payload exceeds delivery limit",
    });
    await f.message({ type: "subscribe", surfaceId: "test" });
    f.notify();
    expect(f.sent.map((message) => JSON.parse(message).type)).toContain("update");
    expect(f.close).not.toHaveBeenCalled();
    expect(f.peak()).toBeLessThan(1024 * 1024);
  } finally {
    await f.cleanup();
  }
});

it("an ordinary 2–3 MiB turn with hundreds of structural events replays completely", async () => {
  const f = await fixture(false, false, false, { calls: 300, inputBytes: 8192 });
  try {
    const expected = compactReplay(f.events);
    const wireBytes = expected.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify({ type: "chat.delta", event })),
      0,
    );
    expect(expected.length).toBeGreaterThan(600);
    expect(wireBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(wireBytes).toBeLessThan(3 * 1024 * 1024);
    await f.message({ type: "chat.subscribe", conversationId: "c" });
    const packets = f.sent.map((message) => JSON.parse(message));
    expect(
      packets.filter((message) => message.type === "chat.delta").map((message) => message.event),
    ).toEqual(expected);
    expect(packets.some((message) => message.type === "chat.resync-required")).toBe(false);
    f.release();
    await f.ended;
    expect(f.close).not.toHaveBeenCalled();
    console.info(
      JSON.stringify({
        fixture: "BE-4 ordinary replay",
        wireBytes,
        replayEvents: expected.length,
        peakBufferedBytes: f.peak(),
        closes: f.close.mock.calls.length,
      }),
    );
  } finally {
    await f.cleanup();
  }
});

it("caught-up subscribers stream a 1 MiB tool input and result live without resync", async () => {
  const f = await fixture(false, false, false, { livePayloadBytes: 1024 * 1024 });
  try {
    const packets = f.sent.map((message) => JSON.parse(message));
    const live = packets
      .filter((message) => message.type === "chat.delta")
      .map((message) => message.event);
    expect(live.find((event) => event.type === "tool-call")).toMatchObject({
      input: { payload: "x".repeat(1024 * 1024) },
    });
    expect(live.find((event) => event.type === "tool-result")).toMatchObject({
      content: "x".repeat(1024 * 1024),
    });
    expect(packets.some((message) => message.type === "chat.resync-required")).toBe(false);
    f.release();
    await f.ended;
    expect(f.close).not.toHaveBeenCalled();
    console.info(
      JSON.stringify({
        fixture: "BE-4 ordinary live tool",
        toolResultBytes: Buffer.byteLength(
          JSON.stringify(packets.find((message) => message.event?.type === "tool-result")),
        ),
        peakBufferedBytes: f.peak(),
        closes: f.close.mock.calls.length,
      }),
    );
  } finally {
    await f.cleanup();
  }
});

it("replay uses the remaining shared backlog budget and omits oversized totals atomically", async () => {
  const f = await fixture(false, false, false, { calls: 300, inputBytes: 8192 });
  try {
    f.setBuffered(4 * 1024 * 1024);
    await f.message({ type: "chat.subscribe", conversationId: "c" });
    const packets = f.sent.map((message) => JSON.parse(message));
    expect(packets.filter((message) => message.type === "chat.delta")).toEqual([]);
    expect(packets).toContainEqual({
      type: "chat.resync-required",
      conversationId: "c",
      turnId: expect.any(String),
      reason: "replay-limit",
    });
    expect(f.close).not.toHaveBeenCalled();
    f.release();
    await f.ended;
    expect(f.close).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
