import { createConversationStore } from "@dispatch/conversation-store";
import { type AgentEvent, type ProviderContract, runTurn } from "@dispatch/kernel";
import { createSessionOrchestrator } from "@dispatch/session-orchestrator";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createMessageQueueService } from "../../message-queue/src/index.js";
import { createApp } from "./app.js";

const provider: ProviderContract = {
  id: "terminal-http-test",
  async *stream() {
    yield { type: "text-delta", delta: "after warning" };
    yield { type: "finish", reason: "stop" };
  },
};

function fixture(runtime: typeof runTurn = runTurn) {
  const store = createConversationStore(storageFromMap());
  const { orchestrator } = createSessionOrchestrator({
    conversationStore: store,
    resolveProvider: () => provider,
    resolveModel: () => undefined,
    resolveTools: () => [],
    applyToolsFilter: async (assembly) => assembly,
    runTurn: runtime,
  });
  const app = createApp({
    conversationStore: store,
    orchestrator,
    credentialStore: {} as Parameters<typeof createApp>[0]["credentialStore"],
  });
  return { app, orchestrator };
}

describe("HTTP terminal turn completion", () => {
  it("keeps /chat open past a non-terminal error until turn-ended", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { app, orchestrator } = fixture(async (input) => {
      input.emit({
        type: "error",
        conversationId: input.conversationId,
        turnId: input.turnId,
        message: "non-terminal warning",
      });
      await gate;
      return runTurn(input);
    });
    const response = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "stream", message: "go" }),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected stream");
    let output = "";
    while (!output.includes("non-terminal warning")) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      output += new TextDecoder().decode(chunk.value);
    }
    let closed = false;
    const next = reader.read().then((chunk) => {
      closed = chunk.done === true;
      return chunk;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      expect(orchestrator.isActive("stream")).toBe(true);
    } finally {
      release();
    }
    let chunk = await next;
    while (!chunk.done) {
      output += new TextDecoder().decode(chunk.value);
      chunk = await reader.read();
    }
    const events: AgentEvent[] = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.some((event) => event.type === "text-delta" && event.delta === "after warning"),
    ).toBe(true);
    expect(events.filter((event) => event.type === "turn-ended")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", reason: "sealed" });
  });

  it("/last settles on a rejected turn instead of waiting for a seal", async () => {
    const { app, orchestrator } = fixture();
    orchestrator.startTurn({ conversationId: "rejected", text: "go", modelName: "unknown/model" });
    const response = await app.request("/conversations/rejected/last");
    expect(await response.json()).toMatchObject({
      conversationId: "rejected",
      content: "",
      turnId: expect.any(String),
    });
  });
});

describe("HTTP compaction-deferred completion", () => {
  it.each([
    "start",
    "stop",
    "close",
    "cancel",
    "combined",
    "barrier-failure",
  ])("/chat settles on %s", async (action) => {
    const store = createConversationStore(storageFromMap());
    let id = 0;
    const queue = createMessageQueueService({ id: () => String(++id), now: () => 0, notify() {} });
    const { orchestrator, compacting } = createSessionOrchestrator({
      conversationStore: store,
      resolveQueue: () => queue,
      resolveProvider: () => provider,
      resolveTools: () => [],
      applyToolsFilter: async (assembly) => assembly,
      runTurn,
    });
    const barrier = Promise.withResolvers<void>();
    compacting.set("c", barrier.promise);
    const app = createApp({
      conversationStore: store,
      orchestrator,
      credentialStore: {} as Parameters<typeof createApp>[0]["credentialStore"],
    });
    const response = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "c", message: "mine" }),
    });
    expect(response.status).toBe(200);
    expect(queue.getQueue("c").map((message) => message.text)).toEqual(["mine"]);
    if (action === "stop") orchestrator.stopTurn("c");
    if (action === "close") orchestrator.closeConversation("c");
    if (action === "cancel")
      orchestrator.cancelQueuedMessage({ conversationId: "c", messageId: "1" });
    if (action === "combined") await orchestrator.enqueue({ conversationId: "c", text: "other" });
    compacting.delete("c");
    if (action === "barrier-failure") barrier.reject(new Error("failed"));
    else barrier.resolve();
    const events: AgentEvent[] = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (action === "start" || action === "stop") {
      expect(events[0]).toMatchObject({ type: "user-message", text: "mine" });
      expect(events.some((e) => e.type === "text-delta")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "turn-ended", reason: "sealed" });
    } else {
      expect(events.map((event) => event.type)).toEqual(["error", "turn-ended"]);
      expect(events[0]).toMatchObject({
        message: expect.stringContaining(
          action === "combined"
            ? "superseded"
            : action === "barrier-failure"
              ? "failed"
              : "dropped",
        ),
      });
      expect(events.at(-1)).toMatchObject({ reason: "rejected" });
    }
    expect(events.filter((e) => e.type === "turn-ended")).toHaveLength(1);
  });
});
