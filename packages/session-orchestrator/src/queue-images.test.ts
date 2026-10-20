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
  mode: "steering" | "carry" | "error" = "carry",
  storageGate?: ReturnType<typeof gate>,
) {
  const store = createConversationStore(storageFromMap());
  const entered = gate();
  const release = gate();
  const stored = gate();
  let id = 0;
  const queue = createMessageQueueService({
    id: () => String(++id),
    now: () => 0,
    notify: () => {},
  });
  const requests: { messages: readonly ChatMessage[]; computerId?: string }[] = [];
  const events: AgentEvent[] = [];
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
        await release.promise;
        if (mode === "steering") {
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
    conversationStore: store,
    resolveProvider: () => provider,
    resolveQueue: () => queue,
    resolveVisionHandoff: () => vision,
    resolveTools: () => [tool],
    applyToolsFilter: async (assembly) => assembly,
    runTurn: (input) => {
      requests.push({
        messages: input.messages,
        ...(input.computerId ? { computerId: input.computerId } : {}),
      });
      return runTurn(input);
    },
  });
  bundle.orchestrator.subscribe("c", (event) => events.push(event));
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
  ] as const)("stores compact images before %s and persists delivery", async (mode) => {
    const f = fixture(mode);
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
    f.release.resolve();
    await completed;
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
  ] as const)("%s cancels storage-pending input without leaking into a later turn", async (operation) => {
    const storage = gate();
    const f = fixture("carry", storage);
    f.orchestrator.startTurn({ conversationId: "c", text: "opening" });
    await f.entered.promise;
    const pending = f.orchestrator.enqueue({ conversationId: "c", text: "cancelled", images });
    await f.stored.promise;
    const behind = f.orchestrator.enqueue({ conversationId: "c", text: "also cancelled" });
    if (operation === "close") f.orchestrator.closeConversation("c");
    else if (operation === "stopAll") f.orchestrator.stopAll();
    else f.orchestrator.stopTurn("c");
    const completed = f.ended(1);
    f.release.resolve();
    await completed;
    const restarted = f.ended(2);
    expect(
      (await f.orchestrator.enqueue({ conversationId: "c", text: "explicit restart" })).startedTurn,
    ).toBe(true);
    await restarted;
    storage.resolve();
    expect(await pending).toEqual({ startedTurn: false, queue: [] });
    expect(await behind).toEqual({ startedTurn: false, queue: [] });
    expect(JSON.stringify(await f.store.load("c"))).not.toContain("cancelled");
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

it("Stop cancels an idle storage-pending enqueue before any turn has started", async () => {
  const storage = gate();
  const f = fixture("carry", storage);
  const pending = f.orchestrator.enqueue({ conversationId: "c", text: "", images });
  await f.stored.promise;
  expect(f.orchestrator.stopTurn("c")).toEqual({ abortedTurn: false });
  storage.resolve();
  expect(await pending).toEqual({ startedTurn: false, queue: [] });
  expect(f.requests).toEqual([]);
  expect(await f.store.load("c")).toEqual([]);
});
