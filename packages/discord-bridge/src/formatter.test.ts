import type { AgentEvent, StepId } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import { DISCORD_MESSAGE_LIMIT } from "./format.js";
import { type RelayEvent, RelayFormatter, TURN_STOPPED, type UpsertOp } from "./formatter.js";

const c = "conv";
const t = "t1";
const sid = (s: string) => s as StepId;

/** Final content per key, in post order. */
function render(ops: readonly UpsertOp[]): string[] {
  const order: string[] = [];
  const content = new Map<string, string>();
  for (const op of ops) {
    if (!content.has(op.key)) order.push(op.key);
    content.set(op.key, op.content);
  }
  return order.map((k) => content.get(k) ?? "");
}

function run(events: readonly RelayEvent[], f = new RelayFormatter()): UpsertOp[] {
  return events.flatMap((e) => f.push(e));
}

/** A two-step turn: think → text → tool (step 1), then the answer (step 2). */
const TWO_STEP_TURN: AgentEvent[] = [
  { type: "user-message", conversationId: c, turnId: t, text: "hello\nworld" },
  { type: "turn-start", conversationId: c, turnId: t },
  { type: "reasoning-delta", conversationId: c, turnId: t, delta: "Let me " },
  { type: "reasoning-delta", conversationId: c, turnId: t, delta: "think" },
  { type: "text-delta", conversationId: c, turnId: t, delta: "I'll list files." },
  {
    type: "tool-call",
    conversationId: c,
    turnId: t,
    stepId: sid("t1#0"),
    toolCallId: "a",
    toolName: "shell",
    input: { command: "ls -la" },
  },
  {
    type: "usage",
    conversationId: c,
    turnId: t,
    stepId: sid("t1#0"),
    usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 900 },
  },
  {
    type: "step-complete",
    conversationId: c,
    turnId: t,
    stepId: sid("t1#0"),
    ttftMs: 500,
    decodeMs: 1_000,
    genTotalMs: 1_500,
  },
  {
    type: "tool-result",
    conversationId: c,
    turnId: t,
    stepId: sid("t1#0"),
    toolCallId: "a",
    toolName: "shell",
    content: "file1\nfile2",
    isError: false,
    durationMs: 1_234,
  },
  { type: "text-delta", conversationId: c, turnId: t, delta: "Done." },
  {
    type: "usage",
    conversationId: c,
    turnId: t,
    stepId: sid("t1#1"),
    usage: { inputTokens: 1_100, outputTokens: 5 },
  },
  {
    type: "step-complete",
    conversationId: c,
    turnId: t,
    stepId: sid("t1#1"),
    decodeMs: 100,
    genTotalMs: 1_400,
  },
  {
    type: "done",
    conversationId: c,
    turnId: t,
    reason: "stop",
    durationMs: 4_000,
    usage: { inputTokens: 2_100, outputTokens: 55, cacheReadTokens: 900 },
    contextSize: 1_105,
  },
  { type: "turn-sealed", conversationId: c, turnId: t },
  { type: "turn-ended", conversationId: c, turnId: t, reason: "sealed" },
];

describe("RelayFormatter — live mirroring golden", () => {
  it("echo, thinking, response, tool (posted then edited), step footers, turn summary", () => {
    expect(render(run(TWO_STEP_TURN))).toEqual([
      "-# 💬 sent from Dispatch\n> hello\n> world",
      "-# 💭 thinking\n> Let me think",
      "I'll list files.",
      "🔧 **shell** · `ls -la` · ✅ 1.2s\n```\nfile1\nfile2\n```\n-# step 1 · 1,000 in (900 cached) / 50 out · 50 tok/s · 1.5s",
      "Done.\n-# step 2 · 1,100 in / 5 out · 50 tok/s · 1.4s\n-# turn 1 · 55 tok out · 2,100 in (900 cached) · 50 tok/s · 4.0s · 1,105 tokens in context",
    ]);
  });

  it("posts the tool message at the call, then edits the outcome into the SAME message", () => {
    const ops = run(TWO_STEP_TURN);
    const toolOps = ops.filter((o) => o.content.startsWith("🔧"));
    expect(new Set(toolOps.map((o) => o.key)).size).toBe(1);
    expect(toolOps[0]?.content).toBe("🔧 **shell** · `ls -la`");
    expect(toolOps[0]?.group).toBe("t1#0");
    expect(toolOps.at(-1)?.compact).toBe(
      "🔧 **shell** · `ls -la` · ✅ 1.2s\n-# step 1 · 1,000 in (900 cached) / 50 out · 50 tok/s · 1.5s",
    );
  });

  it("numbers turns from the persisted baseline", () => {
    const f = new RelayFormatter({ initialTurnCount: 6 });
    const out = render(run(TWO_STEP_TURN, f));
    expect(out.at(-1)).toContain("-# turn 7 ·");
    expect(f.turns).toBe(7);
  });

  it("aborted turn → `-# turn stopped`", () => {
    const out = render(
      run([
        { type: "turn-start", conversationId: c, turnId: t },
        { type: "text-delta", conversationId: c, turnId: t, delta: "partial" },
        { type: "done", conversationId: c, turnId: t, reason: "aborted" },
      ]),
    );
    expect(out).toEqual([`partial\n${TURN_STOPPED}`]);
  });

  it("a step with no message gets a standalone footer; error and retry notices", () => {
    const out = render(
      run([
        { type: "turn-start", conversationId: c, turnId: t },
        {
          type: "provider-retry",
          conversationId: c,
          turnId: t,
          attempt: 1,
          delayMs: 5_000,
          message: "HTTP 529",
        },
        {
          type: "error",
          conversationId: c,
          turnId: t,
          message: "boom\nBearer sekrit-token-value",
        },
      ]),
    );
    expect(out).toEqual(["-# retrying (2)…", "-# ⚠️ boom Bearer …redacted…"]);
    const footerOnly = render(
      run([
        { type: "turn-start", conversationId: c, turnId: t },
        { type: "step-complete", conversationId: c, turnId: t, stepId: sid("s") },
      ]),
    );
    expect(footerOnly).toEqual(["-# step 1 · 0 in / 0 out"]);
  });

  it("steering echo counts images; replay echo too", () => {
    const out = render(
      run([
        {
          type: "steering",
          conversationId: c,
          turnId: t,
          text: "look",
          images: [{ url: "https://x/a.png" }, { url: "https://x/b.png" }],
        },
        { type: "replay-user-message", turnId: "t2", text: "", imageCount: 1 },
      ]),
    );
    expect(out).toEqual([
      "-# 💬 sent from Dispatch · 2 images\n> look",
      "-# 💬 sent from Dispatch · 1 image",
    ]);
  });

  it("thinking is shown in full up to the limit, then middle-cut with a footer reserve", () => {
    const long = `START${"thought ".repeat(1_000)}END`;
    const ops = run([
      { type: "reasoning-delta", conversationId: c, turnId: t, delta: long },
      { type: "reasoning-end", conversationId: c, turnId: t },
      { type: "step-complete", conversationId: c, turnId: t, stepId: sid("s"), genTotalMs: 2_000 },
    ]);
    const final = render(ops)[0] ?? "";
    expect(final.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(final).toContain("> START");
    expect(final).toContain("END\n-# step 1");
    expect(final).toMatch(/…\[[\d,]+ characters omitted\]…/);
  });

  it("long responses are split losslessly, the footer lands on the last part", () => {
    const text = Array.from({ length: 200 }, (_, i) => `paragraph ${i} ${"x".repeat(30)}`).join(
      "\n",
    );
    const out = render(
      run([
        { type: "text-delta", conversationId: c, turnId: t, delta: text },
        { type: "step-complete", conversationId: c, turnId: t, stepId: sid("s") },
      ]),
    );
    expect(out.length).toBeGreaterThan(3);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    const last = out.at(-1) ?? "";
    expect(last.endsWith("-# step 1 · 0 in / 0 out")).toBe(true);
    const joined = [...out.slice(0, -1), last.replace(/\n-# step 1 · 0 in \/ 0 out$/, "")].join(
      "\n",
    );
    expect(joined).toBe(text);
  });

  it("a tool result whose call was never seen is posted standalone", () => {
    const out = render(
      run([
        {
          type: "tool-result",
          conversationId: c,
          turnId: t,
          stepId: sid("s"),
          toolCallId: "z",
          toolName: "read_file",
          content: "x",
          isError: true,
          durationMs: 400,
        },
      ]),
    );
    expect(out).toEqual(["🔧 **read_file** · ❌ 0.4s\n```\nx\n```"]);
  });

  it("flush() emits a half-built response", () => {
    const f = new RelayFormatter();
    f.push({ type: "text-delta", conversationId: c, turnId: t, delta: "half" });
    expect(f.flush().map((o) => o.content)).toEqual(["half"]);
  });
});
