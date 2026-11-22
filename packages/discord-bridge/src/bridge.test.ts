import { createLogger } from "@dispatch/kernel";
import type { StepId, StoredChunk, TurnMetrics } from "@dispatch/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bridge, promptFromMessage, resolveConversationRef } from "./bridge.js";
import type { ChatAuthor, ChatEvent, ChatMessageEvent } from "./client.js";
import { systemClock } from "./extension.js";
import { chat, FakeFelicity, FakeOrchestrator, FakeStore, meta } from "./test-support.js";

const logger = createLogger(
  { extensionId: "test" },
  { emit: () => {} },
  {
    now: () => 0,
    newId: () => "x",
  },
);

const OWNER: ChatAuthor = {
  id: "100000000000000001",
  username: "owner",
  displayName: "Owner",
  isOwner: true,
};
const ALICE: ChatAuthor = { id: "111", username: "alice", displayName: "Alice", isOwner: false };

const A = "aaaa1111-0000-0000-0000-000000000000";
const B1 = "bbbb1111-0000-0000-0000-000000000000";
const B2 = "bbbb2222-0000-0000-0000-000000000000";

let cursor = 0;
function envelope(threadId: string | null, conversationId: string | null) {
  cursor += 1;
  return {
    cursor,
    createdAt: new Date(Date.now()).toISOString(),
    guildId: "g1",
    channelId: threadId ?? "p1",
    threadId,
    conversationId,
    sourceMessageId: `src-${cursor}`,
  };
}
const openEv = (ref: string, count = 20): ChatEvent => ({
  ...envelope(null, null),
  kind: "chat.open",
  data: { author: OWNER, conversationRef: ref, count, requestedCount: count, clamped: false },
});
const msgEv = (
  threadId: string,
  conv: string,
  content: string,
  author = OWNER,
): ChatMessageEvent => ({
  ...envelope(threadId, conv),
  kind: "chat.message",
  data: { author, content, attachments: [], replyTo: null },
});

function history(turnId: string): { chunks: StoredChunk[]; metrics: TurnMetrics[] } {
  return {
    chunks: [
      { seq: 1, role: "user", turnId, chunk: { type: "text", text: "old prompt" } },
      { seq: 2, role: "assistant", turnId, chunk: { type: "text", text: "old answer" } },
    ],
    metrics: [
      {
        turnId,
        usage: { inputTokens: 10, outputTokens: 2 },
        steps: [{ stepId: `${turnId}#0` as StepId, usage: { inputTokens: 10, outputTokens: 2 } }],
      },
    ],
  };
}

function setup() {
  const fake = new FakeFelicity();
  const orch = new FakeOrchestrator();
  const store = new FakeStore();
  store.metas.set(A, meta(A, "Alpha", { model: "umans/glm" }));
  store.metas.set(B1, meta(B1, "Beta one"));
  store.metas.set(B2, meta(B2, "Beta two"));
  store.cwds.set(A, "/home/x");
  const h = history("old1");
  store.chunks.set(A, h.chunks);
  store.metrics.set(A, h.metrics);
  let n = 0;
  const bridge = new Bridge({
    client: fake,
    orchestrator: orch,
    store,
    clock: systemClock,
    logger,
    newId: () => String(n++),
  });
  return { fake, orch, store, bridge };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe("pure helpers", () => {
  it("resolveConversationRef: exact id, unique prefix ≥ 4, ambiguous, none", () => {
    const ids = [A, B1, B2];
    expect(resolveConversationRef(ids, A)).toEqual({ kind: "unique", id: A });
    expect(resolveConversationRef(ids, "aaaa")).toEqual({ kind: "unique", id: A });
    expect(resolveConversationRef(ids, "bbbb")).toEqual({
      kind: "ambiguous",
      candidates: [B1, B2],
    });
    expect(resolveConversationRef(ids, "aaa")).toEqual({ kind: "none" });
    expect(resolveConversationRef(ids, "zzzz")).toEqual({ kind: "none" });
  });

  it("promptFromMessage: images → ImageInput, files → links, participants attributed", () => {
    const ev: ChatMessageEvent = {
      ...msgEv("th", A, "look", ALICE),
      data: {
        author: ALICE,
        content: "look",
        replyTo: null,
        attachments: [
          {
            id: "1",
            filename: "a.png",
            url: "https://cdn/a.png",
            contentType: "image/png",
            size: 1,
            isImage: true,
          },
          {
            id: "2",
            filename: "log.txt",
            url: "https://cdn/log.txt",
            contentType: "text/plain",
            size: 1,
            isImage: false,
          },
        ],
      },
    };
    expect(promptFromMessage(ev)).toEqual({
      text: "[Discord: Alice (@alice, 111)]\nlook\n[attachment: log.txt](https://cdn/log.txt)",
      images: [{ url: "https://cdn/a.png", mimeType: "image/png" }],
    });
  });
});

describe("Bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("open: resolves the prefix, binds with title/model/cwd, replays history paced, acks", async () => {
    const { fake, bridge } = setup();
    bridge.start();
    const ev = openEv("aaaa");
    fake.pushEvents(ev);
    await tick(10);
    expect(fake.ops("bind")).toEqual([
      {
        op: "bind",
        cursor: ev.cursor,
        input: { conversationId: A, title: "Alpha", model: "umans/glm", cwd: "/home/x" },
      },
    ]);
    expect(fake.ops("ack")).toEqual([{ op: "ack", cursor: ev.cursor }]);
    await tick(10_000);
    const thread = `thread-${ev.cursor}`;
    expect(fake.posts.filter((p) => p.channelId === thread).map((p) => p.content)).toEqual([
      "-# replaying last 2 of 2 messages…",
      "-# 💬 sent from Dispatch\n> old prompt",
      "old answer\n-# step 1 · 10 in / 2 out\n-# turn 1 · 2 tok out · 10 in",
    ]);
    // typing lease taken during replay, released once drained (idle conversation)
    const typing = fake.ops("typing");
    expect(typing[0]).toMatchObject({ active: true });
    expect(typing.at(-1)).toMatchObject({ active: false });
    await bridge.stop();
  });

  it("open: ambiguous / unknown / stale events are rejected", async () => {
    const { fake, bridge } = setup();
    bridge.start();
    const amb = openEv("bbbb");
    const none = openEv("zzzz");
    const stale = { ...openEv("aaaa"), createdAt: new Date(Date.now() - 61_000).toISOString() };
    fake.pushEvents(amb, none, stale);
    await tick(10);
    expect(fake.ops("reject")).toEqual([
      {
        op: "reject",
        cursor: amb.cursor,
        reason: "ambiguous",
        extra: {
          candidates: [
            { id: B1, title: "Beta one" },
            { id: B2, title: "Beta two" },
          ],
        },
      },
      { op: "reject", cursor: none.cursor, reason: "not_found" },
      { op: "reject", cursor: stale.cursor, reason: "offline" },
    ]);
    expect(fake.ops("bind")).toHaveLength(0);
    await bridge.stop();
  });

  it("open: D23 already-open is dropped without attaching", async () => {
    const { fake, bridge } = setup();
    fake.bindResult = () => ({ kind: "already-open", chat: chat("elsewhere", A) });
    bridge.start();
    fake.pushEvents(openEv("aaaa"));
    await tick(10);
    expect(bridge.relayCount).toBe(0);
    expect(fake.ops("reject")).toHaveLength(0);
    await bridge.stop();
  });

  it("messages: ▶️ for a new turn, own prompt not echoed, 📥 → ✅ for a delivered steer", async () => {
    const { fake, orch, bridge } = setup();
    fake.openChats = [chat("th", A)];
    bridge.start();
    await tick(10);
    expect(bridge.relayFor("th")).toBeDefined();

    const m1 = msgEv("th", A, "do the thing");
    fake.pushEvents(m1);
    await tick(10);
    expect(orch.enqueued.map((e) => e.text)).toEqual(["do the thing"]);
    orch.emit({ type: "user-message", conversationId: A, turnId: "t9", text: "do the thing" });
    orch.emit({ type: "turn-start", conversationId: A, turnId: "t9" });

    const m2 = msgEv("th", A, "also this");
    fake.pushEvents(m2);
    await tick(10);
    orch.emit({ type: "steering", conversationId: A, turnId: "t9", text: "also this" });
    orch.emit({ type: "text-delta", conversationId: A, turnId: "t9", delta: "ok" });
    orch.emit({ type: "done", conversationId: A, turnId: "t9", reason: "stop" });
    orch.emit({ type: "turn-ended", conversationId: A, turnId: "t9", reason: "sealed" });
    await tick(20_000);

    const reacts = fake
      .ops("react")
      .map((r) => (r.op === "react" ? `${r.messageId}:${r.emoji}` : ""));
    expect(reacts).toEqual([
      `${m1.sourceMessageId}:▶️`,
      `${m2.sourceMessageId}:📥`,
      `${m2.sourceMessageId}:✅`,
    ]);
    expect(fake.posts.map((p) => p.content)).toEqual(["ok\n-# turn 2 · 0 tok out · 0 in"]);
    await bridge.stop();
  });

  it("prompts typed in Dispatch are echoed; participants are attributed", async () => {
    const { fake, orch, bridge } = setup();
    fake.openChats = [chat("th", A)];
    bridge.start();
    await tick(10);
    orch.emit({ type: "user-message", conversationId: A, turnId: "u1", text: "from the UI" });
    fake.pushEvents(msgEv("th", A, "hi there", ALICE));
    await tick(10_000);
    expect(fake.posts.map((p) => p.content)).toEqual(["-# 💬 sent from Dispatch\n> from the UI"]);
    expect(orch.enqueued.map((e) => e.text)).toEqual(["[Discord: Alice (@alice, 111)]\nhi there"]);
    await bridge.stop();
  });

  it("stop → stopTurn + ⏹️; close → detached and unsubscribed", async () => {
    const { fake, orch, bridge } = setup();
    fake.openChats = [chat("th", A)];
    orch.active.add(A);
    bridge.start();
    await tick(10);
    const stop: ChatEvent = { ...envelope("th", A), kind: "chat.stop", data: { author: OWNER } };
    fake.pushEvents(stop);
    await tick(5_000);
    expect(orch.stopped).toEqual([A]);
    expect(fake.ops("react")).toEqual([
      { op: "react", channelId: "th", messageId: stop.sourceMessageId, emoji: "⏹️" },
    ]);
    expect(orch.subscriberCount(A)).toBe(1);
    fake.pushEvents({
      ...envelope("th", A),
      kind: "chat.close",
      data: { reason: "command", author: OWNER },
    });
    await tick(10);
    expect(bridge.relayCount).toBe(0);
    expect(orch.subscriberCount(A)).toBe(0);
    await bridge.stop();
  });

  it("boot re-attach: live chats attach without replay; missing conversations disconnect", async () => {
    const { fake, orch, bridge } = setup();
    fake.openChats = [chat("th1", A), chat("th2", "gone-0000"), chat("th3", null)];
    bridge.start();
    await tick(10_000);
    expect(bridge.relayFor("th1")?.conversationId).toBe(A);
    expect(bridge.relayCount).toBe(1);
    expect(fake.ops("disconnect")).toEqual([
      { op: "disconnect", threadId: "th2", reason: "conversation_unavailable" },
    ]);
    expect(fake.posts).toHaveLength(0);
    expect(orch.subscriberCount(A)).toBe(1);
    await bridge.stop();
  });

  it("conversation closed in Dispatch → relay disconnected (D24); deleted → unavailable", async () => {
    const { fake, orch, bridge } = setup();
    fake.openChats = [chat("th1", A), chat("th2", B1)];
    bridge.start();
    await tick(10);
    await bridge.onConversationClosed(A);
    await bridge.onConversationDeleted(B1);
    expect(fake.ops("disconnect")).toEqual([
      { op: "disconnect", threadId: "th1", reason: "conversation_closed" },
      { op: "disconnect", threadId: "th2", reason: "conversation_unavailable" },
    ]);
    expect(bridge.relayCount).toBe(0);
    expect(orch.subscriberCount(A)).toBe(0);
    await bridge.stop();
  });

  it("in-flight turn at open comes from the live stream, not history (no duplicates)", async () => {
    const { fake, orch, bridge } = setup();
    orch.active.add(A);
    orch.buffer.set(A, [
      { type: "user-message", conversationId: A, turnId: "live1", text: "running" },
      { type: "turn-start", conversationId: A, turnId: "live1" },
      // a stray replay of the already-persisted turn must be ignored
      { type: "text-delta", conversationId: A, turnId: "old1", delta: "dup" },
    ]);
    bridge.start();
    fake.pushEvents(openEv("aaaa", 300));
    await tick(15_000);
    expect(fake.posts.map((p) => p.content)).toEqual([
      "-# replaying last 2 of 2 messages…",
      "-# 💬 sent from Dispatch\n> old prompt",
      "old answer\n-# step 1 · 10 in / 2 out\n-# turn 1 · 2 tok out · 10 in",
      "-# 💬 sent from Dispatch\n> running",
    ]);
    await bridge.stop();
  });

  it("poll failures back off and recover; stop() ends polling and releases typing", async () => {
    const { fake, orch, bridge } = setup();
    fake.openChats = [chat("th", A)];
    const poll = fake.pollEvents.bind(fake);
    let failures = 2;
    fake.pollEvents = async (...a) => {
      if (failures-- > 0) throw new Error("ECONNREFUSED");
      return poll(...a);
    };
    bridge.start();
    await tick(10);
    orch.emit({ type: "turn-start", conversationId: A, turnId: "x" });
    await tick(5_000);
    expect(fake.polls).toBe(1);
    expect(fake.ops("typing").at(-1)).toMatchObject({ active: true });
    await bridge.stop();
    expect(fake.ops("typing").at(-1)).toMatchObject({ active: false });
    expect(orch.subscriberCount(A)).toBe(0);
  });
});
