import { createConversationStore } from "@dispatch/conversation-store";
import { type AgentEvent, type ProviderContract, runTurn } from "@dispatch/kernel";
import { createSessionOrchestrator } from "@dispatch/session-orchestrator";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
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
