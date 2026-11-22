/**
 * The relay formatter — a deterministic state machine that turns a
 * conversation's events (live `AgentEvent`s, or the synthetic events the
 * replay builder derives from persisted history) into Discord message
 * UPSERTS: "message `key` should now read `content`". The paced sender turns
 * the first upsert of a key into a post and later ones into edits.
 *
 * No I/O, no clock: the same event sequence always yields the same upserts,
 * which is what makes replayed history look identical to the live relay.
 */

import type { AgentEvent, StepMetrics, Usage } from "@dispatch/wire";
import {
  DISCORD_MESSAGE_LIMIT,
  FOOTER_RESERVE,
  formatStepFooter,
  formatTurnSummary,
  labelledQuote,
  sanitizeError,
  splitMessage,
  splitQuoted,
  summarizeToolInput,
  toolHeader,
  toolOutcome,
  toolResultBlock,
} from "./format.js";

/**
 * A user prompt reconstructed from persisted history (the live stream's
 * `user-message` event carries no image count; history does).
 */
export interface ReplayUserMessageEvent {
  readonly type: "replay-user-message";
  readonly turnId: string;
  readonly text: string;
  readonly imageCount: number;
}

/** Everything the formatter consumes. */
export type RelayEvent = AgentEvent | ReplayUserMessageEvent;

/** "Discord message `key` should now read `content`." */
export interface UpsertOp {
  readonly type: "upsert";
  /** Stable per-formatter message key (`m1`, `m2`, …). */
  readonly key: string;
  readonly content: string;
  /**
   * A short form of the same message (tool header + outcome, no result
   * block), used when the sender merges a backlog of tool messages.
   */
  readonly compact?: string;
  /** Messages sharing a group (one step's tool messages) may be merged under backlog. */
  readonly group?: string;
}

/** The thinking message label. */
export const THINKING_LABEL = "-# 💭 thinking";
/** The echo label for prompts not sent from this Discord thread. */
export const ECHO_LABEL = "-# 💬 sent from Dispatch";
/** Posted (or appended) when a turn ends via Stop. */
export const TURN_STOPPED = "-# turn stopped";

interface ToolState {
  readonly header: string;
  result?: { readonly content: string; readonly isError: boolean; readonly durationMs?: number };
}

interface Msg {
  readonly key: string;
  readonly kind: "text" | "thinking" | "tool" | "notice" | "echo";
  body: string;
  readonly suffixes: string[];
  readonly group?: string;
  readonly thinking?: string;
  readonly tool?: ToolState;
}

interface TurnState {
  readonly turnId: string;
  stepIndex: number;
  /** Last message produced in the current step (footer target). */
  lastStepKey: string | undefined;
  /** Last non-echo message produced in this turn (turn-summary target). */
  lastKey: string | undefined;
  readonly usageByStep: Map<string, Usage>;
  lastUsage: Usage | undefined;
  readonly steps: StepMetrics[];
  thinking: string | null;
  text: string;
  readonly tools: Map<string, string>;
}

export interface RelayFormatterOptions {
  /**
   * Turns already counted before the first `done` this formatter sees (the
   * persisted metrics count), so the next summary reads `turn <n + 1>`.
   */
  readonly initialTurnCount?: number;
}

function suffixLength(suffixes: readonly string[]): number {
  return suffixes.reduce((n, s) => n + s.length + 1, 0);
}

function sumUsage(steps: readonly StepMetrics[]): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let sawCache = false;
  for (const s of steps) {
    inputTokens += s.usage.inputTokens;
    outputTokens += s.usage.outputTokens;
    if (s.usage.cacheReadTokens !== undefined) {
      sawCache = true;
      cacheReadTokens += s.usage.cacheReadTokens;
    }
  }
  return sawCache ? { inputTokens, outputTokens, cacheReadTokens } : { inputTokens, outputTokens };
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export class RelayFormatter {
  private nextKey = 1;
  private readonly msgs = new Map<string, Msg>();
  private turn: TurnState | null = null;
  private turnCount: number;

  constructor(opts: RelayFormatterOptions = {}) {
    this.turnCount = opts.initialTurnCount ?? 0;
  }

  /** Turns counted so far (persisted baseline + every `done` seen). */
  get turns(): number {
    return this.turnCount;
  }

  /** Feed one event; returns the upserts it causes, in order. */
  push(ev: RelayEvent): UpsertOp[] {
    const out: UpsertOp[] = [];
    switch (ev.type) {
      case "user-message":
        this.ensureTurn(ev.turnId, out);
        this.echo(ev.text, 0, out);
        break;
      case "replay-user-message":
        this.ensureTurn(ev.turnId, out);
        this.echo(ev.text, ev.imageCount, out);
        break;
      case "steering": {
        const t = this.ensureTurn(ev.turnId, out);
        this.flushPending(t, out);
        this.echo(ev.text, ev.images?.length ?? 0, out);
        break;
      }
      case "turn-start":
        this.ensureTurn(ev.turnId, out);
        break;
      case "reasoning-delta": {
        const t = this.ensureTurn(ev.turnId, out);
        this.flushText(t, out);
        t.thinking = (t.thinking ?? "") + ev.delta;
        break;
      }
      case "reasoning-end":
        this.flushThinking(this.ensureTurn(ev.turnId, out), out);
        break;
      case "text-delta": {
        const t = this.ensureTurn(ev.turnId, out);
        this.flushThinking(t, out);
        t.text += ev.delta;
        break;
      }
      case "tool-call":
        this.toolCall(ev.turnId, ev.toolCallId, ev.toolName, ev.input, out);
        break;
      case "tool-result":
        this.toolResult(ev.turnId, ev.toolCallId, ev.toolName, ev, out);
        break;
      case "usage": {
        const t = this.ensureTurn(ev.turnId, out);
        if (ev.stepId !== undefined) t.usageByStep.set(ev.stepId, ev.usage);
        else t.lastUsage = ev.usage;
        break;
      }
      case "step-complete":
        this.stepComplete(ev, out);
        break;
      case "error": {
        const t = this.ensureTurn(ev.turnId, out);
        this.flushPending(t, out);
        this.notice(t, `-# ⚠️ ${sanitizeError(ev.message)}`, out);
        break;
      }
      case "provider-retry": {
        const t = this.ensureTurn(ev.turnId, out);
        this.flushPending(t, out);
        this.notice(t, `-# retrying (${ev.attempt + 1})…`, out);
        break;
      }
      case "done":
        this.done(ev, out);
        break;
      case "turn-ended":
        if (this.turn !== null && this.turn.turnId === ev.turnId) {
          this.flushPending(this.turn, out);
          this.turn = null;
        }
        break;
      case "status":
      case "tool-output":
      case "turn-sealed":
        break;
    }
    return out;
  }

  /** Flush any half-built thinking/response (e.g. before detaching). */
  flush(): UpsertOp[] {
    const out: UpsertOp[] = [];
    if (this.turn !== null) this.flushPending(this.turn, out);
    return out;
  }

  // ── turn / step bookkeeping ─────────────────────────────────────────────

  private ensureTurn(turnId: string, out: UpsertOp[]): TurnState {
    if (this.turn !== null && this.turn.turnId === turnId) return this.turn;
    if (this.turn !== null) this.flushPending(this.turn, out);
    this.turn = {
      turnId,
      stepIndex: 0,
      lastStepKey: undefined,
      lastKey: undefined,
      usageByStep: new Map(),
      lastUsage: undefined,
      steps: [],
      thinking: null,
      text: "",
      tools: new Map(),
    };
    return this.turn;
  }

  private stepComplete(ev: Extract<AgentEvent, { type: "step-complete" }>, out: UpsertOp[]): void {
    const t = this.ensureTurn(ev.turnId, out);
    this.flushPending(t, out);
    const usage = t.usageByStep.get(ev.stepId) ?? t.lastUsage ?? ZERO_USAGE;
    t.lastUsage = undefined;
    const step: StepMetrics = {
      stepId: ev.stepId,
      usage,
      ...(ev.ttftMs !== undefined ? { ttftMs: ev.ttftMs } : {}),
      ...(ev.decodeMs !== undefined ? { decodeMs: ev.decodeMs } : {}),
      ...(ev.genTotalMs !== undefined ? { genTotalMs: ev.genTotalMs } : {}),
    };
    t.steps.push(step);
    const footer = formatStepFooter(step, t.stepIndex);
    if (!(t.lastStepKey !== undefined && this.attach(t.lastStepKey, footer, out))) {
      this.notice(t, footer, out);
    }
    t.stepIndex += 1;
    t.lastStepKey = undefined;
  }

  private done(ev: Extract<AgentEvent, { type: "done" }>, out: UpsertOp[]): void {
    const t = this.ensureTurn(ev.turnId, out);
    this.flushPending(t, out);
    this.turnCount += 1;
    let line: string;
    if (ev.reason === "aborted") {
      line = TURN_STOPPED;
    } else {
      line = formatTurnSummary(
        {
          turnId: ev.turnId,
          usage: ev.usage ?? sumUsage(t.steps),
          steps: t.steps,
          ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
          ...(ev.contextSize !== undefined ? { contextSize: ev.contextSize } : {}),
        },
        this.turnCount,
      );
    }
    if (!(t.lastKey !== undefined && this.attach(t.lastKey, line, out))) {
      const key = this.newMsg({ kind: "notice", body: line, suffixes: [] });
      out.push(this.render(key));
    }
  }

  // ── content producers ───────────────────────────────────────────────────

  private flushPending(t: TurnState, out: UpsertOp[]): void {
    this.flushThinking(t, out);
    this.flushText(t, out);
  }

  private flushThinking(t: TurnState, out: UpsertOp[]): void {
    if (t.thinking === null) return;
    const text = t.thinking;
    t.thinking = null;
    if (text.trim().length === 0) return;
    const key = this.newMsg({ kind: "thinking", body: "", suffixes: [], thinking: text });
    this.produced(t, key);
    out.push(this.render(key));
  }

  private flushText(t: TurnState, out: UpsertOp[]): void {
    const text = t.text;
    t.text = "";
    if (text.trim().length === 0) return;
    for (const part of splitMessage(text.trim(), DISCORD_MESSAGE_LIMIT)) {
      const key = this.newMsg({ kind: "text", body: part, suffixes: [] });
      this.produced(t, key);
      out.push(this.render(key));
    }
  }

  private toolCall(
    turnId: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    out: UpsertOp[],
  ): void {
    const t = this.ensureTurn(turnId, out);
    this.flushPending(t, out);
    const key = this.newMsg({
      kind: "tool",
      body: "",
      suffixes: [],
      group: `${t.turnId}#${t.stepIndex}`,
      tool: { header: toolHeader(toolName, summarizeToolInput(input)) },
    });
    t.tools.set(toolCallId, key);
    this.produced(t, key);
    out.push(this.render(key));
  }

  private toolResult(
    turnId: string,
    toolCallId: string,
    toolName: string,
    ev: { readonly content: string; readonly isError: boolean; readonly durationMs?: number },
    out: UpsertOp[],
  ): void {
    const t = this.ensureTurn(turnId, out);
    let key = t.tools.get(toolCallId);
    if (key === undefined) {
      // A result without a seen call (attached mid-step): post it standalone.
      this.toolCall(turnId, toolCallId, toolName, undefined, out);
      key = t.tools.get(toolCallId);
      out.pop();
    }
    const msg = key === undefined ? undefined : this.msgs.get(key);
    if (msg?.tool === undefined || key === undefined) return;
    msg.tool.result = {
      content: ev.content,
      isError: ev.isError,
      ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
    };
    out.push(this.render(key));
  }

  private echo(text: string, imageCount: number, out: UpsertOp[]): void {
    const images =
      imageCount === 1 ? " · 1 image" : imageCount > 1 ? ` · ${imageCount} images` : "";
    const label = `${ECHO_LABEL}${images}`;
    const parts = text.trim().length === 0 ? [label] : splitQuoted(label, text);
    for (const part of parts) {
      const key = this.newMsg({ kind: "echo", body: part, suffixes: [] });
      out.push(this.render(key));
    }
  }

  private notice(t: TurnState, line: string, out: UpsertOp[]): void {
    const key = this.newMsg({ kind: "notice", body: line, suffixes: [] });
    this.produced(t, key);
    out.push(this.render(key));
  }

  // ── message model ───────────────────────────────────────────────────────

  private newMsg(init: Omit<Msg, "key">): string {
    const key = `m${this.nextKey++}`;
    this.msgs.set(key, { key, ...init });
    return key;
  }

  private produced(t: TurnState, key: string): void {
    t.lastStepKey = key;
    t.lastKey = key;
  }

  /** Append a suffix line to a message if it still fits; emits the edit. */
  private attach(key: string, line: string, out: UpsertOp[]): boolean {
    const msg = this.msgs.get(key);
    if (msg === undefined) return false;
    this.refreshBody(msg);
    const length = msg.body.length + suffixLength(msg.suffixes) + line.length + 1;
    if (length > DISCORD_MESSAGE_LIMIT) return false;
    msg.suffixes.push(line);
    out.push(this.render(key));
    return true;
  }

  /** Re-render thinking/tool bodies (their budget depends on the suffixes). */
  private refreshBody(msg: Msg): void {
    const budget = DISCORD_MESSAGE_LIMIT - Math.max(FOOTER_RESERVE, suffixLength(msg.suffixes)) - 0;
    if (msg.kind === "thinking" && msg.thinking !== undefined) {
      if (msg.body.length === 0) msg.body = labelledQuote(THINKING_LABEL, msg.thinking, budget);
    } else if (msg.kind === "tool" && msg.tool !== undefined) {
      const head =
        msg.tool.result === undefined
          ? msg.tool.header
          : `${msg.tool.header} · ${toolOutcome(msg.tool.result.isError, msg.tool.result.durationMs)}`;
      msg.body =
        msg.tool.result === undefined
          ? head
          : head + toolResultBlock(msg.tool.result.content, head.length, budget);
    }
  }

  private render(key: string): UpsertOp {
    const msg = this.msgs.get(key);
    if (msg === undefined) throw new Error(`unknown message ${key}`);
    this.refreshBody(msg);
    const content = [msg.body, ...msg.suffixes].join("\n");
    if (msg.kind === "tool" && msg.tool !== undefined) {
      const outcome =
        msg.tool.result === undefined
          ? ""
          : ` · ${toolOutcome(msg.tool.result.isError, msg.tool.result.durationMs)}`;
      const compact = [`${msg.tool.header}${outcome}`, ...msg.suffixes].join("\n");
      return {
        type: "upsert",
        key,
        content,
        compact,
        ...(msg.group !== undefined ? { group: msg.group } : {}),
      };
    }
    return { type: "upsert", key, content };
  }
}
