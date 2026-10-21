import { createConversationStore } from "@dispatch/conversation-store";
import type {
  AgentEvent,
  ChatMessage,
  ImageInput,
  ProviderContract,
  ToolContract,
} from "@dispatch/kernel";
import { runTurn } from "@dispatch/kernel";
import { buildQueueSpec, createMessageQueueService } from "@dispatch/message-queue";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createSessionOrchestrator, type VisionHandoffService } from "./orchestrator.js";

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const images: readonly ImageInput[] = [
  { url: "data:image/png;base64,AAAA", mimeType: "image/png" },
];
const storedImage = { url: "/images/c/queued.png", mimeType: "image/png" };
const storedImages: readonly ImageInput[] = [
  { url: "/images/c/queued.png", mimeType: "image/png" },
];
const imageChunks = storedImages.map((image) => ({ type: "image", ...image }));
const tool: ToolContract = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: {} },
  concurrencySafe: true,
  execute: async () => ({ content: "ok" }),
};

function fixture(
  mode: "steering" | "carry" | "error" | "tool" = "carry",
  storageGate?: ReturnType<typeof gate>,
  settleGate?: ReturnType<typeof gate>,
) {
  const store = createConversationStore(storageFromMap());
  const entered = gate();
  const release = gate();
  const stored = gate();
  const toolEntered = gate();
  const toolAborted = gate();
  const settling = gate();
  let appends = 0;
  let id = 0;
  const queue = createMessageQueueService({
    id: () => String(++id),
    now: () => 0,
    notify: () => {},
  });
  const requests: { messages: readonly ChatMessage[]; computerId?: string }[] = [];
  const events: AgentEvent[] = [];
  const compactions: string[] = [];
  const vision: VisionHandoffService = {
    storeImages: async (_id, input) => {
      stored.resolve();
      await storageGate?.promise;
      return input.map((image) => (image.url.startsWith("data:") ? storedImage : image));
    },
    purgeConversationImages: async () => {},
    // Deliberately identity: represents a vision-capable outer adapter.
    prepareForProvider: async (messages) => messages,
  };
  const providerRequests: (readonly ChatMessage[])[] = [];
  let calls = 0;
  const provider: ProviderContract = {
    id: "queue-images",
    async *stream(messages) {
      providerRequests.push([...messages]);
      if (++calls === 1) {
        entered.resolve();
        yield { type: "text-delta", delta: "partial" };
        if (mode !== "tool") await release.promise;
        if (mode === "steering" || mode === "tool") {
          yield { type: "tool-call", toolCallId: "echo-1", toolName: "echo", input: {} };
          yield { type: "finish", reason: "tool-calls" };
          return;
        }
        if (mode === "error") {
          yield { type: "error", message: "failed" };
          return;
        }
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  const bundle = createSessionOrchestrator({
    conversationStore: {
      ...store,
      appendMetrics: async (...args) => {
        if (++appends === 1) {
          settling.resolve();
          await settleGate?.promise;
        }
        await store.appendMetrics(...args);
      },
    },
    resolveProvider: () => provider,
    resolveQueue: () => queue,
    resolveVisionHandoff: () => vision,
    resolveCompaction: () => ({
      compact: async (id) => {
        compactions.push(id);
        return { skipped: true, reason: "below threshold" };
      },
    }),
    resolveTools: () => [
      mode !== "tool"
        ? tool
        : {
            ...tool,
            execute: async (_input, ctx) => {
              toolEntered.resolve();
              await new Promise<void>((resolve) =>
                ctx.signal.addEventListener(
                  "abort",
                  () => {
                    toolAborted.resolve();
                    resolve();
                  },
                  { once: true },
                ),
              );
              return { content: "aborted tool" };
            },
          },
    ],
    applyToolsFilter: async (assembly) => assembly,
    runTurn: (input) => {
      requests.push({
        messages: input.messages,
        ...(input.computerId ? { computerId: input.computerId } : {}),
      });
      return runTurn(input);
    },
  });
  bundle.orchestrator.subscribe("c", (event) => {
    // Carry must open synchronously after the old terminal, with no compaction/idle gap.
    if (event.type === "user-message" && event.text === "one\n\ntwo") {
      expect(compactions).toEqual([]);
      expect(bundle.activeConversations.has("c")).toBe(true);
    }
    events.push(event);
  });
  const ended = (count: number) =>
    new Promise<void>((resolve) => {
      const unsubscribe = bundle.orchestrator.subscribe("c", () => {
        if (events.filter((event) => event.type === "turn-ended").length >= count) {
          unsubscribe();
          resolve();
        }
      });
    });
  return {
    ...bundle,
    store,
    queue,
    entered,
    release,
    stored,
    toolEntered,
    toolAborted,
    settling,
    requests,
    providerRequests,
    events,
    ended,
  };
}

describe("queued images and computer metadata", () => {
  it.each([
    "steering",
    "carry",
    "error",
    "stop",
    "stopAll",
  ] as const)("stores compact images before %s and persists delivery", async (mode) => {
    const f = fixture(mode === "stop" || mode === "stopAll" ? "steering" : mode);
    f.orchestrator.startTurn({ conversationId: "c", text: "opening", computerId: "original" });
    await f.entered.promise;
    const first = await f.orchestrator.enqueue({
      conversationId: "c",
      text: "one",
      images,
      computerId: "remote-a",
    });
    const second = await f.orchestrator.enqueue({
      conversationId: "c",
      text: "two",
      images,
      computerId: "remote-b",
    });
    expect(first.startedTurn).toBe(false);
    expect(
      second.queue.map((message) => [message.text, message.images, message.computerId]),
    ).toEqual([
      ["one", storedImages, "remote-a"],
      ["two", storedImages, "remote-b"],
    ]);
    expect(JSON.stringify(second.queue)).not.toContain("base64");
    const field = buildQueueSpec(second.queue).fields[0];
    expect(field).toMatchObject({ payload: { messages: [{ imageCount: 1 }, { imageCount: 1 }] } });
    const completed = f.ended(mode === "steering" ? 1 : 2);
    if (mode === "stop") f.orchestrator.stopTurn("c");
    if (mode === "stopAll") expect(f.orchestrator.stopAll()).toEqual({ stopped: 1 });
    f.release.resolve();
    await completed;
    if (mode === "stop" || mode === "stopAll") {
      expect(
        f.events.filter((event) => event.type === "turn-ended").map((event) => event.reason),
      ).toEqual(["aborted", "sealed"]);
      expect(f.events.some((event) => event.type === "steering")).toBe(false);
    }
    const users = (await f.store.load("c")).filter((message) => message.role === "user");
    expect(users.at(-1)?.chunks).toEqual(
      mode === "steering"
        ? [
            { type: "text", text: "one" },
            ...imageChunks,
            { type: "text", text: "two" },
            ...imageChunks,
          ]
        : [{ type: "text", text: "one\n\ntwo" }, ...imageChunks, ...imageChunks],
    );
    expect(await f.store.getComputerId("c")).toBe("remote-b");
    expect(f.queue.getQueue("c")).toEqual([]);
    if (mode === "steering") {
      expect(f.events.find((event) => event.type === "steering")).toMatchObject({
        text: "one\n\ntwo",
        images: [...storedImages, ...storedImages],
      });
      expect(f.providerRequests[1]?.flatMap((message) => message.chunks)).toEqual(
        expect.arrayContaining(imageChunks),
      );
      expect(f.requests).toHaveLength(1); // Does not switch the running tool context.
      expect(f.requests[0]?.computerId).toBe("original");
      await f.orchestrator.handleMessage({ conversationId: "c", text: "next", onEvent: () => {} });
    }
    expect(f.requests.at(-1)?.computerId).toBe("remote-b");
    expect(f.requests.at(-1)?.messages.flatMap((message) => message.chunks)).toEqual(
      expect.arrayContaining(imageChunks),
    );
  });

  it.each([
    "stop",
    "close",
    "stopAll",
  ] as const)("%s applies its queue policy to storage-pending input in FIFO order", async (operation) => {
    const storage = gate();
    const f = fixture("carry", storage);
    f.orchestrator.startTurn({ conversationId: "c", text: "opening" });
    await f.entered.promise;
    const pending = f.orchestrator.enqueue({
      conversationId: "c",
      text: "pending image",
      images,
      computerId: "remote-a",
    });
    await f.stored.promise;
    const behind = f.orchestrator.enqueue({ conversationId: "c", text: "following text" });
    if (operation === "close") f.orchestrator.closeConversation("c");
    else if (operation === "stopAll") f.orchestrator.stopAll();
    else f.orchestrator.stopTurn("c");
    const completed = f.ended(1);
    f.release.resolve();
    await completed;
    if (operation === "close") {
      const restarted = f.ended(2);
      expect(
        (await f.orchestrator.enqueue({ conversationId: "c", text: "explicit restart" }))
          .startedTurn,
      ).toBe(true);
      await restarted;
      storage.resolve();
      expect(await pending).toEqual({ startedTurn: false, queue: [] });
      expect(await behind).toEqual({ startedTurn: false, queue: [] });
      expect(JSON.stringify(await f.store.load("c"))).not.toContain("pending image");
      expect(JSON.stringify(await f.store.load("c"))).not.toContain("following text");
    } else {
      const carried = f.ended(3);
      storage.resolve();
      expect((await pending).startedTurn).toBe(true);
      await behind;
      await carried;
      expect(
        f.events.filter((event) => event.type === "user-message").map((event) => event.text),
      ).toEqual(["opening", "pending image", "following text"]);
      expect(
        (await f.store.load("c")).filter((message) => message.role === "user")[1]?.chunks,
      ).toEqual([{ type: "text", text: "pending image" }, ...imageChunks]);
      expect(f.requests[1]?.computerId).toBe("remote-a");
      expect(f.events.some((event) => event.type === "steering")).toBe(false);
    }
    expect(f.queue.getQueue("c")).toEqual([]);
  });

  it("preserves insertion order across slow image storage and rechecks activity after storage", async () => {
    const storage = gate();
    const f = fixture("carry", storage);
    f.orchestrator.startTurn({ conversationId: "c", text: "opening" });
    await f.entered.promise;
    const first = f.orchestrator.enqueue({ conversationId: "c", text: "image first", images });
    await f.stored.promise;
    const second = f.orchestrator.enqueue({ conversationId: "c", text: "text second" });
    expect(f.queue.getQueue("c")).toEqual([]);
    // The original turn ends while storage is pending. Delivery must start a new turn.
    const completed = f.ended(1);
    f.release.resolve();
    await completed;
    const both = f.ended(3);
    storage.resolve();
    expect((await first).startedTurn).toBe(true);
    await second;
    await both;
    expect(
      (await f.store.load("c"))
        .filter((message) => message.role === "user")
        .map((message) => message.chunks[0]),
    ).toEqual([
      { type: "text", text: "opening" },
      { type: "text", text: "image first" },
      { type: "text", text: "text second" },
    ]);
  });

  it.each([
    "startTurn",
    "handleMessage",
  ] as const)("compaction-deferred %s and enqueue retain images and last computer override", async (entry) => {
    const f = fixture();
    const compacting = gate();
    f.compacting.set("c", compacting.promise);
    const input = { conversationId: "c", text: "one", images, computerId: "remote-a" };
    const handled =
      entry === "handleMessage"
        ? f.orchestrator.handleMessage({ ...input, onEvent: () => {} })
        : undefined;
    if (entry === "startTurn") expect(f.orchestrator.startTurn(input).started).toBe(false);
    await f.orchestrator.enqueue({ conversationId: "c", text: "", images, computerId: "remote-b" });
    expect(f.queue.getQueue("c").map((message) => message.images)).toEqual([
      storedImages,
      storedImages,
    ]);
    const completed = f.ended(1);
    f.compacting.delete("c");
    compacting.resolve();
    await f.entered.promise;
    f.release.resolve();
    await completed;
    await handled;
    expect(f.events.some((event) => event.type === "error")).toBe(false);
    expect(f.requests[0]?.computerId).toBe("remote-b");
    expect((await f.store.load("c"))[0]?.chunks).toEqual([
      { type: "text", text: "one\n\n" },
      ...imageChunks,
      ...imageChunks,
    ]);
  });
});

it("rejects failed image storage without inserting input and allows later enqueue", async () => {
  const queue = createMessageQueueService({ id: () => "q", now: () => 0, notify: () => {} });
  const vision: VisionHandoffService = {
    storeImages: async () => {
      throw new Error("image disk full");
    },
    purgeConversationImages: async () => {},
    prepareForProvider: async (messages) => messages,
  };
  const store = createConversationStore(storageFromMap());
  const { orchestrator } = createSessionOrchestrator({
    conversationStore: store,
    resolveProvider: () => ({
      id: "done",
      stream: async function* () {
        yield { type: "finish", reason: "stop" };
      },
    }),
    resolveVisionHandoff: () => vision,
    resolveQueue: () => queue,
    resolveTools: () => [],
    applyToolsFilter: async (assembly) => assembly,
    runTurn,
  });
  await expect(orchestrator.enqueue({ conversationId: "c", text: "lost", images })).rejects.toThrow(
    "image disk full",
  );
  expect(queue.getQueue("c")).toEqual([]);
  expect(await store.load("c")).toEqual([]);
  const completed = new Promise<void>((resolve) =>
    orchestrator.subscribe("c", (event) => {
      if (event.type === "turn-ended") resolve();
    }),
  );
  expect((await orchestrator.enqueue({ conversationId: "c", text: "retry" })).startedTurn).toBe(
    true,
  );
  await completed;
});

it.each([
  "stop",
  "stopAll",
] as const)("%s preserves an idle storage-pending enqueue before any turn has started", async (operation) => {
  const storage = gate();
  const f = fixture("carry", storage);
  const pending = f.orchestrator.enqueue({ conversationId: "c", text: "", images });
  await f.stored.promise;
  if (operation === "stop") expect(f.orchestrator.stopTurn("c")).toEqual({ abortedTurn: false });
  else expect(f.orchestrator.stopAll()).toEqual({ stopped: 0 });
  const completed = f.ended(1);
  storage.resolve();
  expect(await pending).toEqual({ startedTurn: true, queue: [] });
  await f.entered.promise;
  f.release.resolve();
  await completed;
  expect(f.requests).toHaveLength(1);
  expect((await f.store.load("c"))[0]?.chunks).toEqual(imageChunks);
});

it("Stop aborts an executing tool before carrying queued input, without steering it", async () => {
  const f = fixture("tool");
  f.orchestrator.startTurn({ conversationId: "c", text: "opening" });
  await f.toolEntered.promise;
  await f.orchestrator.enqueue({ conversationId: "c", text: "queued after tool" });
  const completed = f.ended(2);
  expect(f.orchestrator.stopTurn("c")).toEqual({ abortedTurn: true });
  await f.toolAborted.promise;
  await completed;
  expect(
    f.events.filter((event) => event.type === "turn-ended").map((event) => event.reason),
  ).toEqual(["aborted", "sealed"]);
  const terminal = f.events.findIndex((event) => event.type === "turn-ended");
  const carried = f.events.findIndex(
    (event) => event.type === "user-message" && event.text === "queued after tool",
  );
  expect(terminal).toBeLessThan(carried);
  expect(f.events.some((event) => event.type === "steering")).toBe(false);
  expect(f.providerRequests).toHaveLength(2);
  expect(f.orchestrator.isActive("c")).toBe(false);
  expect(JSON.stringify(await f.store.load("c"))).toContain("partial");
});

it.each([
  "stop",
  "close",
] as const)("%s with compaction-deferred input preserves its policy", async (operation) => {
  const f = fixture();
  const barrier = gate();
  f.compacting.set("c", barrier.promise);
  const deferred = await f.orchestrator.enqueue({ conversationId: "c", text: "deferred", images });
  expect(deferred.startedTurn).toBe(false);
  expect(deferred.queue).toHaveLength(1);
  if (operation === "stop") {
    expect(f.orchestrator.stopTurn("c")).toEqual({ abortedTurn: false });
    expect(f.queue.getQueue("c")).toEqual(deferred.queue);
    const completed = f.ended(1);
    f.compacting.delete("c");
    barrier.resolve();
    await f.entered.promise;
    f.release.resolve();
    await completed;
    expect((await f.store.load("c"))[0]?.chunks).toEqual([
      { type: "text", text: "deferred" },
      ...imageChunks,
    ]);
  } else {
    f.orchestrator.closeConversation("c");
    f.compacting.delete("c");
    barrier.resolve();
    // Observe the registered waiter before asserting that it did not restart.
    await barrier.promise;
    expect(f.events).toEqual([]);
    expect(await f.store.load("c")).toEqual([]);
  }
  expect(f.queue.getQueue("c")).toEqual([]);
});

it("item cancellation after Stop but before carry removes only that input", async () => {
  const f = fixture();
  f.orchestrator.startTurn({ conversationId: "c", text: "opening" });
  await f.entered.promise;
  const first = await f.orchestrator.enqueue({ conversationId: "c", text: "cancel me" });
  await f.orchestrator.enqueue({ conversationId: "c", text: "keep me" });
  const id = first.queue[0]?.id;
  if (id === undefined) throw new Error("missing queued id");
  const completed = f.ended(2);
  f.orchestrator.stopTurn("c");
  expect(f.orchestrator.cancelQueuedMessage({ conversationId: "c", messageId: id }).cancelled).toBe(
    true,
  );
  await completed;
  expect(
    f.events.filter((event) => event.type === "user-message").map((event) => event.text),
  ).toEqual(["opening", "keep me"]);
  expect(JSON.stringify(await f.store.load("c"))).not.toContain("cancel me");
  f.release.resolve();
});

it("repeated Stop aborts a carried turn and carries its new queue exactly once", async () => {
  const store = createConversationStore(storageFromMap());
  let id = 0;
  const queue = createMessageQueueService({
    id: () => String(++id),
    now: () => 0,
    notify: () => {},
  });
  const entered = [gate(), gate()];
  let calls = 0;
  const provider: ProviderContract = {
    id: "repeated-stop",
    async *stream() {
      const gate = entered[calls++];
      if (gate !== undefined) {
        yield { type: "text-delta", delta: "partial" };
        gate.resolve();
        await new Promise<void>(() => {}); // Deliberately ignores abort: consumer must interrupt.
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  const { orchestrator, activeConversations } = createSessionOrchestrator({
    conversationStore: store,
    resolveProvider: () => provider,
    resolveQueue: () => queue,
    resolveTools: () => [],
    applyToolsFilter: async (assembly) => assembly,
    runTurn,
  });
  const events: AgentEvent[] = [];
  const completed = new Promise<void>((resolve) =>
    orchestrator.subscribe("c", (event) => {
      events.push(event);
      if (events.filter((event) => event.type === "turn-ended").length === 3) resolve();
    }),
  );
  orchestrator.startTurn({ conversationId: "c", text: "opening" });
  await entered[0]?.promise;
  await orchestrator.enqueue({ conversationId: "c", text: "first carry" });
  orchestrator.stopTurn("c");
  orchestrator.stopTurn("c");
  await entered[1]?.promise;
  await orchestrator.enqueue({ conversationId: "c", text: "second carry" });
  orchestrator.stopTurn("c");
  await completed;
  const ended = events.filter((event) => event.type === "turn-ended");
  expect(ended.map((event) => event.reason)).toEqual(["aborted", "aborted", "sealed"]);
  expect(new Set(ended.map((event) => event.turnId)).size).toBe(3);
  expect(
    events.filter((event) => event.type === "user-message").map((event) => event.text),
  ).toEqual(["opening", "first carry", "second carry"]);
  expect(events.filter((event) => event.type === "done").map((event) => event.reason)).toEqual([
    "aborted",
    "aborted",
    "stop",
  ]);
  expect(events.some((event) => event.type === "steering")).toBe(false);
  expect(queue.getQueue("c")).toEqual([]);
  expect(activeConversations.size).toBe(0);
  expect(orchestrator.stopTurn("c")).toEqual({ abortedTurn: false });
  expect(
    (await store.load("c"))
      .filter((message) => message.role === "user")
      .map((message) => message.chunks),
  ).toEqual(["opening", "first carry", "second carry"].map((text) => [{ type: "text", text }]));
});

it("pending image storage finishing during abort cleanup joins the immediate FIFO carry", async () => {
  const storage = gate();
  const settle = gate();
  const f = fixture("carry", storage, settle);
  f.orchestrator.startTurn({ conversationId: "c", text: "opening" });
  await f.entered.promise;
  await f.orchestrator.enqueue({ conversationId: "c", text: "before storage" });
  const pending = f.orchestrator.enqueue({ conversationId: "c", text: "pending image", images });
  await f.stored.promise;
  f.orchestrator.stopTurn("c");
  const behind = f.orchestrator.enqueue({
    conversationId: "c",
    text: "abort-window text",
    computerId: "remote-b",
  });
  await f.settling.promise;
  expect(f.events.filter((event) => event.type === "done").map((event) => event.reason)).toEqual([
    "aborted",
  ]);
  storage.resolve();
  expect((await pending).startedTurn).toBe(false);
  expect((await behind).queue.map((message) => message.text)).toEqual([
    "before storage",
    "pending image",
    "abort-window text",
  ]);
  const completed = f.ended(2);
  settle.resolve();
  await completed;
  expect(
    f.events.filter((event) => event.type === "user-message").map((event) => event.text),
  ).toEqual(["opening", "before storage\n\npending image\n\nabort-window text"]);
  expect(f.events.some((event) => event.type === "steering")).toBe(false);
  expect((await f.store.load("c")).filter((message) => message.role === "user")[1]?.chunks).toEqual(
    [
      { type: "text", text: "before storage\n\npending image\n\nabort-window text" },
      ...imageChunks,
    ],
  );
  expect(f.requests[1]?.computerId).toBe("remote-b");
  expect(f.queue.getQueue("c")).toEqual([]);
  f.release.resolve();
});
