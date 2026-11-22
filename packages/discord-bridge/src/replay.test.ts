import type { StepId, StoredChunk, TurnMetrics } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import {
  clampReplayCount,
  historyToEvents,
  planReplay,
  type ReplayMessage,
  renderMessages,
} from "./replay.js";

const sid = (s: string) => s as StepId;

/** The persisted form of the formatter golden's two-step turn. */
function twoStepTurn(turnId: string, startSeq: number): StoredChunk[] {
  const s = (n: number) => startSeq + n;
  return [
    { seq: s(0), role: "user", turnId, chunk: { type: "text", text: "hello\nworld" } },
    { seq: s(1), role: "assistant", turnId, chunk: { type: "thinking", text: "Let me think" } },
    { seq: s(2), role: "assistant", turnId, chunk: { type: "text", text: "I'll list files." } },
    {
      seq: s(3),
      role: "assistant",
      turnId,
      chunk: {
        type: "tool-call",
        toolCallId: `${turnId}-a`,
        toolName: "shell",
        input: { command: "ls -la" },
        stepId: sid(`${turnId}#0`),
      },
    },
    {
      seq: s(4),
      role: "tool",
      turnId,
      chunk: {
        type: "tool-result",
        toolCallId: `${turnId}-a`,
        toolName: "shell",
        content: "file1\nfile2",
        isError: false,
        stepId: sid(`${turnId}#0`),
      },
    },
    { seq: s(5), role: "assistant", turnId, chunk: { type: "text", text: "Done." } },
  ];
}

function twoStepMetrics(turnId: string, extra: Partial<TurnMetrics> = {}): TurnMetrics {
  return {
    turnId,
    usage: { inputTokens: 2_100, outputTokens: 55, cacheReadTokens: 900 },
    durationMs: 4_000,
    contextSize: 1_105,
    steps: [
      {
        stepId: sid(`${turnId}#0`),
        usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 900 },
        ttftMs: 500,
        decodeMs: 1_000,
        genTotalMs: 1_500,
      },
      {
        stepId: sid(`${turnId}#1`),
        usage: { inputTokens: 1_100, outputTokens: 5 },
        decodeMs: 100,
        genTotalMs: 1_400,
      },
    ],
    ...extra,
  };
}

const contents = (ms: readonly ReplayMessage[]) => ms.map((m) => m.content);

describe("historyToEvents + renderMessages — history looks like the live relay", () => {
  it("reproduces the live golden (tool durations are not persisted)", () => {
    const out = contents(
      renderMessages(historyToEvents("c", twoStepTurn("t1", 1), [twoStepMetrics("t1")])),
    );
    expect(out).toEqual([
      "-# 💬 sent from Dispatch\n> hello\n> world",
      "-# 💭 thinking\n> Let me think",
      "I'll list files.",
      "🔧 **shell** · `ls -la` · ✅\n```\nfile1\nfile2\n```\n-# step 1 · 1,000 in (900 cached) / 50 out · 50 tok/s · 1.5s",
      "Done.\n-# step 2 · 1,100 in / 5 out · 50 tok/s · 1.4s\n-# turn 1 · 55 tok out · 2,100 in (900 cached) · 50 tok/s · 4.0s · 1,105 tokens in context",
    ]);
  });

  it("numbers turns across history and marks aborted turns", () => {
    const chunks = [...twoStepTurn("t1", 1), ...twoStepTurn("t2", 100)];
    const out = contents(
      renderMessages(
        historyToEvents("c", chunks, [
          twoStepMetrics("t1"),
          twoStepMetrics("t2", { aborted: true }),
        ]),
      ),
    );
    expect(out[4]).toContain("-# turn 1 ·");
    expect(out.at(-1)).toBe(
      "Done.\n-# step 2 · 1,100 in / 5 out · 50 tok/s · 1.4s\n-# turn stopped",
    );
  });

  it("history without metrics: no footers, no summary; images counted; first text only", () => {
    const chunks: StoredChunk[] = [
      { seq: 1, role: "user", chunk: { type: "text", text: "see pic" } },
      { seq: 2, role: "user", chunk: { type: "image", url: "https://x/a.png" } },
      { seq: 3, role: "user", chunk: { type: "text", text: "(transcription)" } },
      { seq: 4, role: "assistant", chunk: { type: "text", text: "nice" } },
      { seq: 5, role: "system", chunk: { type: "system", text: "ignored" } },
      { seq: 6, role: "assistant", chunk: { type: "error", message: "late failure" } },
    ];
    expect(contents(renderMessages(historyToEvents("c", chunks, [])))).toEqual([
      "-# 💬 sent from Dispatch · 1 image\n> see pic",
      "nice",
      "-# ⚠️ late failure",
    ]);
  });

  it("recovers step boundaries without stepIds (legacy rows)", () => {
    const legacy = twoStepTurn("t1", 1).map((c) =>
      c.chunk.type === "tool-call" || c.chunk.type === "tool-result"
        ? { ...c, chunk: { ...c.chunk, stepId: undefined } }
        : c,
    ) as StoredChunk[];
    const out = contents(renderMessages(historyToEvents("c", legacy, [twoStepMetrics("t1")])));
    expect(out[3]).toContain("-# step 1 ·");
    expect(out[4]).toContain("-# step 2 ·");
  });
});

describe("planReplay", () => {
  const all: ReplayMessage[] = Array.from({ length: 30 }, (_, i) => ({
    key: `m${i}`,
    content: `msg ${i}`,
  }));

  it("keeps the last `count` Discord messages with a header", () => {
    const plan = planReplay(all, 20);
    expect(plan.header).toBe("-# replaying last 20 of 30 messages…");
    expect(plan.messages.map((m) => m.content)).toEqual(all.slice(10).map((m) => m.content));
  });
  it("count above the history replays everything", () => {
    expect(planReplay(all, 100).header).toBe("-# replaying last 30 of 30 messages…");
  });
  it("notes a clamp", () => {
    expect(planReplay(all, 300, 1_000).header).toBe(
      "-# replaying last 30 of 30 messages… (requested 1000; max 300)",
    );
  });
  it("count 0 → nothing; empty history → a note", () => {
    expect(planReplay(all, 0)).toEqual({ header: null, messages: [], total: 30 });
    expect(planReplay([], 20).header).toBe("-# no history to replay");
  });
  it("clampReplayCount: default 20, max 300", () => {
    expect(clampReplayCount(undefined)).toBe(20);
    expect(clampReplayCount(5_000)).toBe(300);
    expect(clampReplayCount(-3)).toBe(0);
    expect(clampReplayCount(12.7)).toBe(12);
  });
});
