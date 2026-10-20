import { createConversationStore } from "@dispatch/conversation-store";
import type { ChatMessage } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createApp } from "./app.js";

const user = (text: string): ChatMessage => ({ role: "user", chunks: [{ type: "text", text }] });

function fixture() {
  const store = createConversationStore(storageFromMap());
  const app = createApp({
    conversationStore: store,
    orchestrator: {} as Parameters<typeof createApp>[0]["orchestrator"],
    credentialStore: {} as Parameters<typeof createApp>[0]["credentialStore"],
  });
  return { store, app };
}

describe("HTTP history epoch", () => {
  it("exposes default and persisted epochs without changing latestSeq semantics", async () => {
    const { app, store } = fixture();
    expect(await (await app.request("/conversations/c")).json()).toEqual({
      chunks: [],
      latestSeq: 0,
      historyEpoch: 0,
    });
    await store.append("c", [user("old")]);
    await store.replaceHistory("c", [user("summary")]);
    const response = await app.request("/conversations/c?sinceSeq=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      chunks: [{ seq: 2, role: "user", chunk: user("summary").chunks[0] }],
      latestSeq: 2,
      historyEpoch: 1,
    });
    await store.replaceHistory("c", []);
    expect(await (await app.request("/conversations/c?sinceSeq=2")).json()).toEqual({
      chunks: [],
      latestSeq: 2,
      historyEpoch: 2,
    });
    expect(await (await app.request("/conversations/c")).json()).toEqual({
      chunks: [],
      latestSeq: 0,
      historyEpoch: 2,
    });
  });

  it("waits for an exclusive replacement before reading chunks and epoch", async () => {
    const { app, store } = fixture();
    await store.append("c", [user("old")]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const replacement = store.runExclusive("c", async () => {
      entered();
      await gate;
      await store.replaceHistory("c", [user("summary")]);
    });
    await ready;
    const response = app.request("/conversations/c");
    // Let the request reach the held lock (no clocks or internal mocks).
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await replacement;
    expect(await (await response).json()).toEqual({
      chunks: [{ seq: 2, role: "user", chunk: user("summary").chunks[0] }],
      latestSeq: 2,
      historyEpoch: 1,
    });
  });
});
