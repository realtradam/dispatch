import { createConversationStore } from "@dispatch/conversation-store";
import { type AgentEvent, type ProviderContract, runTurn } from "@dispatch/kernel";
import { createMessageQueueService } from "@dispatch/message-queue";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createSessionOrchestrator } from "./orchestrator.js";

function gate() {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(withQueue = true, rejectModel = false, steering = false) {
  const store = createConversationStore(storageFromMap());
  const barrier = gate();
  const entered = gate();
  const release = gate();
  const storage = gate();
  const storing = gate();
  let id = 0;
  let notify = () => {};
  const queue = createMessageQueueService({
    id: () => String(++id),
    now: () => 0,
    notify: () => notify(),
  });
  let steps = 0;
  const provider: ProviderContract = {
    id: "test",
    async *stream() {
      entered.resolve();
      await release.promise;
      if (steering && ++steps === 1) {
        yield { type: "tool-call", toolCallId: "echo-1", toolName: "echo", input: {} };
        yield { type: "finish", reason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", delta: "own reply" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const bundle = createSessionOrchestrator({
    conversationStore: store,
    resolveProvider: () => {
      if (rejectModel) throw new Error("immediate rejection");
      return provider;
    },
    resolveQueue: () => (withQueue ? queue : undefined),
    resolveTools: () => [
      {
        name: "echo",
        description: "echo",
        parameters: { type: "object" },
        concurrencySafe: true,
        execute: async () => ({ content: "ok" }),
      },
    ],
    applyToolsFilter: async (assembly) => assembly,
    resolveVisionHandoff: () => ({
      storeImages: async (_id, images) => {
        if (images.length) {
          storing.resolve();
          await storage.promise;
        }
        return images;
      },
      prepareForProvider: async (messages) => messages,
      purgeConversationImages: async () => {},
    }),
    runTurn,
  });
  // Exercise the real subscription implementation while counting lifetime ownership.
  const subscribe = bundle.orchestrator.subscribe;
  let listeners = 0;
  bundle.orchestrator.subscribe = (id, listener) => {
    listeners++;
    const dispose = subscribe(id, listener);
    let disposed = false;
    return () => {
      if (!disposed) listeners--;
      disposed = true;
      dispose();
    };
  };
  bundle.compacting.set("c", barrier.promise);
  const open = () => {
    bundle.compacting.delete("c");
    barrier.resolve();
  };
  const events: AgentEvent[] = [];
  const request = (text = "mine", images = false) =>
    bundle.orchestrator.handleMessage({
      conversationId: "c",
      text,
      onEvent: (event) => events.push(event),
      ...(images ? { images: [{ url: "data:image/png;base64,AAAA" }] } : {}),
    });
  return {
    ...bundle,
    store,
    queue,
    barrier,
    open,
    entered,
    release,
    storage,
    storing,
    events,
    request,
    listeners: () => listeners,
    notify: (listener: () => void) => {
      notify = listener;
    },
  };
}

function expectTerminal(events: AgentEvent[], reason: string) {
  expect(events.map((event) => event.type)).toEqual(["error", "turn-ended"]);
  expect(events[0]).toMatchObject({ message: expect.stringContaining(reason) });
  expect(events[1]).toMatchObject({ reason: "rejected", turnId: events[0]?.turnId });
}

describe("compaction-deferred request ownership", () => {
  it("returns distinct admission with queue id, stores once and starts after the barrier", async () => {
    const f = fixture();
    const result = f.orchestrator.startTurn({ conversationId: "c", text: "mine" });
    expect(result).toMatchObject({ started: false, reason: "queued-behind-compaction" });
    if (result.started || result.reason !== "queued-behind-compaction")
      throw new Error("not queued");
    const admitted = await result.admission;
    expect(admitted.messageId).toBe("1");
    expect(admitted.queue.map((m) => m.text)).toEqual(["mine"]);
    expect(await f.store.load("c")).toEqual([]);
    const done = new Promise<void>((resolve) => {
      const dispose = f.orchestrator.subscribe("c", (event) => {
        if (event.type === "turn-ended") {
          dispose();
          resolve();
        }
      });
    });
    f.open();
    f.release.resolve();
    await done;
    expect((await f.store.load("c")).filter((m) => m.role === "user")).toHaveLength(1);
  });

  it.each([
    true,
    false,
  ])("binds before the first event and waits for its own terminal (queue=%s)", async (withQueue) => {
    const f = fixture(withQueue);
    const done = f.request();
    expect(f.listeners()).toBe(1);
    f.orchestrator.stopTurn("c"); // no queued input is dropped; reserved no-queue turn aborts
    f.open();
    f.release.resolve();
    await done;
    expect(f.events[0]).toMatchObject({ type: "user-message", text: "mine" });
    expect(f.events.at(-1)?.type).toBe("turn-ended");
    expect(f.listeners()).toBe(0);
  });

  it.each([
    "close",
    "cancel",
  ])("settles %s immediately without waiting for compaction", async (action) => {
    const f = fixture();
    const done = f.request();
    const id = f.queue.getQueue("c")[0]?.id;
    if (id === undefined) throw new Error("missing queued input");
    if (action === "close") f.orchestrator.closeConversation("c");
    else f.orchestrator.cancelQueuedMessage({ conversationId: "c", messageId: id });
    await done;
    expectTerminal(f.events, "dropped");
    expect(f.listeners()).toBe(0);
    f.open();
    await Promise.resolve();
    expect(f.orchestrator.isActive("c")).toBe(false);
  });

  it("Close settles storage-pending input and late storage cannot reopen it", async () => {
    const f = fixture();
    const done = f.request("image", true);
    await f.storing.promise;
    f.orchestrator.closeConversation("c");
    await done;
    expectTerminal(f.events, "dropped");
    expect(f.listeners()).toBe(0);
    f.open();
    f.storage.resolve();
    await f.orchestrator.enqueue({ conversationId: "other", text: "flush" });
    f.release.resolve();
    expect(f.queue.getQueue("c")).toEqual([]);
  });

  it("combined inputs supersede both callers instead of streaming the combined turn", async () => {
    const f = fixture();
    const first = f.request("one");
    const secondEvents: AgentEvent[] = [];
    const second = f.orchestrator.handleMessage({
      conversationId: "c",
      text: "two",
      onEvent: (e) => secondEvents.push(e),
    });
    // The public enqueue chain provides a deterministic insertion fence.
    await f.orchestrator.enqueue({ conversationId: "c", text: "three" });
    f.open();
    await Promise.all([first, second]);
    expectTerminal(f.events, "superseded");
    expectTerminal(secondEvents, "superseded");
    expect(f.listeners()).toBe(0);
    await f.entered.promise;
    f.release.resolve();
  });

  it("an independently started turn does not become the deferred caller's response", async () => {
    const f = fixture();
    const done = f.request();
    f.compacting.delete("c");
    const other = f.orchestrator.startTurn({ conversationId: "c", text: "other caller" });
    expect(other.started).toBe(true);
    await f.entered.promise;
    f.barrier.resolve();
    f.release.resolve();
    await done; // own input carries after the other turn, not its terminal
    expect(f.events[0]).toMatchObject({ type: "user-message", text: "mine" });
    expect(f.events.filter((event) => event.type === "turn-ended")).toHaveLength(1);
    expect(
      f.events.every(
        (event) => !("turnId" in event) || event.turnId !== (other.started ? other.turnId : ""),
      ),
    ).toBe(true);
    expect(f.listeners()).toBe(0);
  });

  it("settles barrier rejection with no subscriber or queued input left behind", async () => {
    const f = fixture();
    const done = f.request();
    f.compacting.delete("c");
    f.barrier.reject(new Error("barrier failed"));
    await done;
    expectTerminal(f.events, "failed");
    expect(f.queue.getQueue("c")).toEqual([]);
    expect(f.listeners()).toBe(0);
  });

  it("settles image-storage admission failure", async () => {
    const f = fixture();
    const done = f.request("image", true);
    await f.storing.promise;
    f.storage.reject(new Error("disk full"));
    await done;
    expectTerminal(f.events, "disk full");
    expect(f.listeners()).toBe(0);
    f.open();
  });

  it("settles when a deferred input is consumed as steering into another caller's turn", async () => {
    const f = fixture(true, false, true);
    const done = f.request();
    f.compacting.delete("c");
    const otherEvents: AgentEvent[] = [];
    const other = f.orchestrator.handleMessage({
      conversationId: "c",
      text: "other",
      onEvent: (e) => otherEvents.push(e),
    });
    await f.entered.promise;
    f.barrier.resolve();
    f.release.resolve();
    await Promise.all([done, other]);
    expectTerminal(f.events, "superseded");
    expect(otherEvents).toContainEqual(expect.objectContaining({ type: "steering", text: "mine" }));
    expect(f.listeners()).toBe(0);
  });

  it("cancelling the first item preserves the surviving caller's start options", async () => {
    const f = fixture();
    const first = f.orchestrator.startTurn({
      conversationId: "c",
      text: "cancelled",
      cwd: "/cancelled",
    });
    if (first.started || first.reason !== "queued-behind-compaction")
      throw new Error("not deferred");
    await first.admission;
    const done = f.orchestrator.handleMessage({
      conversationId: "c",
      text: "mine",
      cwd: "/mine",
      systemPrompt: "own system prompt",
      onEvent: (e) => f.events.push(e),
    });
    await f.orchestrator.enqueue({ conversationId: "c", text: "fence" });
    f.orchestrator.cancelQueuedMessage({ conversationId: "c", messageId: "1" });
    f.orchestrator.cancelQueuedMessage({ conversationId: "c", messageId: "3" });
    f.open();
    f.release.resolve();
    await done;
    expect(f.events[0]).toMatchObject({ type: "user-message", text: "mine" });
    expect(await f.store.getCwd("c")).toBe("/mine");
    expect(f.listeners()).toBe(0);
  });

  it("Close followed by explicit reopen on the same barrier uses the new request options", async () => {
    const f = fixture();
    const old = f.request("cancelled");
    f.orchestrator.closeConversation("c");
    await old;
    const freshEvents: AgentEvent[] = [];
    const fresh = f.orchestrator.handleMessage({
      conversationId: "c",
      text: "fresh",
      computerId: "fresh-computer",
      onEvent: (e) => freshEvents.push(e),
    });
    f.open();
    f.release.resolve();
    await fresh;
    expectTerminal(f.events, "dropped");
    expect(freshEvents[0]).toMatchObject({ type: "user-message", text: "fresh" });
    expect(freshEvents.at(-1)).toMatchObject({ type: "turn-ended", reason: "sealed" });
    expect(await f.store.getComputerId("c")).toBe("fresh-computer");
    expect(f.listeners()).toBe(0);
  });

  it("start/drain failure settles even if queue notification also throws during cleanup", async () => {
    const f = fixture();
    const done = f.request();
    f.notify(() => {
      throw new Error("surface failed during drain");
    });
    f.open();
    await done;
    expectTerminal(f.events, "failed");
    expect(f.listeners()).toBe(0);
  });

  it("Close reentering through the drain notification cannot restart a deferred turn", async () => {
    const f = fixture();
    const done = f.request();
    f.notify(() => f.orchestrator.closeConversation("c"));
    f.open();
    await done;
    expectTerminal(f.events, "dropped");
    expect(f.orchestrator.isActive("c")).toBe(false);
    expect(f.listeners()).toBe(0);
  });

  it("admission finishing after barrier release binds before synchronous opening and fast rejection", async () => {
    const f = fixture(true, true);
    const done = f.request("image", true);
    await f.storing.promise;
    f.open();
    f.storage.resolve();
    await done;
    expect(f.events[0]).toMatchObject({ type: "user-message", text: "image" });
    expect(f.events.at(-1)).toMatchObject({ type: "turn-ended", reason: "error" });
    expect(f.listeners()).toBe(0);
  });

  it.each([
    true,
    false,
  ])("immediate model rejection with real synchronous-backed store settles (queue=%s)", async (withQueue) => {
    const f = fixture(withQueue, true);
    const done = f.request();
    f.open();
    await done;
    expect(f.events[0]).toMatchObject({ type: "user-message", text: "mine" });
    expect(f.events.at(-1)).toMatchObject({ type: "turn-ended", reason: "error" });
    expect(f.listeners()).toBe(0);
  });
});
