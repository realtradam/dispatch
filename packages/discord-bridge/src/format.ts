/**
 * Pure text helpers for the Dispatch → Discord relay: number formatting
 * (parity with the web frontend's metrics formatting), Discord-limit-aware
 * middle truncation, the lossless (code-fence-aware) splitter, block quotes,
 * tool-input summaries, and the step-footer / turn-summary lines.
 *
 * No I/O, no clock, no state — every function is input → output.
 */

import type { StepMetrics, TurnMetrics, Usage } from "@dispatch/wire";

/** Discord's hard per-message content limit (characters). */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Space thinking and tool messages keep free for the step footer that is
 * edited onto the last message of a step (a footer is ~80 characters).
 */
export const FOOTER_RESERVE = 100;

/** Longest one-line tool-input summary in a tool message header. */
export const TOOL_SUMMARY_MAX = 120;

// ─── Numbers (parity with frontend/src/core/metrics/format.ts) ──────────────

/** `en-US` thousands separators: `41200` → `41,200`. */
export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** Sub-second → `850ms`, else one decimal seconds (`4.1s`). `null` when absent/zero. */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Tool durations always read in seconds with one decimal (`0.4s`, `1.2s`). */
export function formatToolDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Tokens/second: one decimal under 10, rounded otherwise. */
export function formatTps(tps: number | null): string | null {
  if (tps === null || !Number.isFinite(tps)) return null;
  if (tps < 10) return `${tps.toFixed(1)} tok/s`;
  return `${Math.round(tps)} tok/s`;
}

/** Tokens per second, or null when the elapsed time is absent/zero. */
export function computeTps(outputTokens: number, elapsedMs: number | undefined): number | null {
  if (elapsedMs === undefined || elapsedMs <= 0) return null;
  return outputTokens / (elapsedMs / 1000);
}

/** `41,200 in` plus ` (40,960 cached)` when any cache read was reported. */
function formatInput(u: Usage): string {
  let s = `${formatTokens(u.inputTokens)} in`;
  if (u.cacheReadTokens !== undefined && u.cacheReadTokens > 0) {
    s += ` (${formatTokens(u.cacheReadTokens)} cached)`;
  }
  return s;
}

/**
 * The step footer: `-# step 3 · 41,200 in (40,960 cached) / 512 out · 87 tok/s · 4.1s`.
 * `index` is 0-based. TPS = output ÷ decode time; the duration is the step's
 * total generation time. Missing timings drop their segment.
 */
export function formatStepFooter(step: StepMetrics, index: number): string {
  const parts = [
    `step ${index + 1}`,
    `${formatInput(step.usage)} / ${formatTokens(step.usage.outputTokens)} out`,
  ];
  const tps = formatTps(computeTps(step.usage.outputTokens, step.decodeMs));
  if (tps !== null) parts.push(tps);
  const dur = formatDuration(step.genTotalMs);
  if (dur !== null) parts.push(dur);
  return `-# ${parts.join(" · ")}`;
}

/**
 * The turn summary:
 * `-# turn 1 · 36,522 tok out · 2,501,533 in (2,386,092 cached) · 124 tok/s · 397.0s · 148,210 tokens in context`.
 * Turn TPS sums output and decode time over ONLY the steps that report a
 * decode time (frontend parity).
 */
export function formatTurnSummary(turn: TurnMetrics, turnNumber: number): string {
  let timedOut = 0;
  let decodeMs: number | undefined;
  for (const step of turn.steps) {
    if (step.decodeMs === undefined || step.decodeMs <= 0) continue;
    timedOut += step.usage.outputTokens;
    decodeMs = (decodeMs ?? 0) + step.decodeMs;
  }
  const parts = [
    `turn ${turnNumber}`,
    `${formatTokens(turn.usage.outputTokens)} tok out`,
    formatInput(turn.usage),
  ];
  const tps = formatTps(computeTps(timedOut, decodeMs));
  if (tps !== null) parts.push(tps);
  const dur = formatDuration(turn.durationMs);
  if (dur !== null) parts.push(dur);
  if (turn.contextSize !== undefined) {
    parts.push(`${formatTokens(turn.contextSize)} tokens in context`);
  }
  return `-# ${parts.join(" · ")}`;
}

// ─── Truncation / splitting ──────────────────────────────────────────────────

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Move a cut index left so it never separates a surrogate pair. */
function safeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
  return isHighSurrogate(text.charCodeAt(index - 1)) ? index - 1 : index;
}

/** The marker that replaces a cut middle: `…[12,345 characters omitted]…`. */
export function omittedMarker(omitted: number): string {
  return `…[${formatTokens(omitted)} characters omitted]…`;
}

/**
 * Cut the MIDDLE of `text` so the result is at most `max` characters, keeping
 * the head and the tail around an `…[n characters omitted]…` marker. Text that
 * already fits is returned unchanged.
 */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let keep = Math.max(0, max - omittedMarker(text.length).length);
  for (;;) {
    const headLen = safeCut(text, Math.ceil(keep / 2));
    const tailStart = text.length - (keep - headLen);
    const tailCut = safeCut(text, tailStart);
    const omitted = tailCut - headLen;
    const out = `${text.slice(0, headLen)}${omittedMarker(omitted)}${text.slice(tailCut)}`;
    if (out.length <= max || keep === 0) return out.length <= max ? out : out.slice(0, max);
    keep = Math.max(0, keep - (out.length - max));
  }
}

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/** Fence state after `text`, starting from `open` (the opener line, or null). */
function fenceStateAfter(text: string, open: string | null): string | null {
  let state = open;
  for (const line of text.split("\n")) {
    const m = FENCE_RE.exec(line);
    if (m === null) continue;
    if (state === null) state = line.trim();
    else state = null;
  }
  return state;
}

/** Best cut position in `window`: last newline, else last space, else hard. */
function bestCut(text: string, budget: number): { cut: number; skip: number } {
  const window = text.slice(0, budget + 1);
  const nl = window.lastIndexOf("\n");
  if (nl >= budget / 2 && nl <= budget) return { cut: nl, skip: 1 };
  const sp = window.lastIndexOf(" ");
  if (sp >= budget / 2 && sp <= budget) return { cut: sp, skip: 1 };
  return { cut: safeCut(text, budget), skip: 0 };
}

/**
 * Split `text` into consecutive messages of at most `limit` characters
 * WITHOUT dropping content (responses are never truncated). Cuts prefer a
 * newline, then a space (the break character becomes the message boundary).
 * Code fences open at a cut are closed at the end of that part and re-opened
 * (with the same language tag) at the start of the next, so each message
 * renders correctly on its own.
 */
export function splitMessage(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return text.length === 0 ? [] : [text];
  const parts: string[] = [];
  let rest = text;
  let open: string | null = null;
  const CLOSE = "\n```";
  while (rest.length > 0) {
    const prefix = open === null ? "" : `${open}\n`;
    if (prefix.length + rest.length <= limit) {
      parts.push(prefix + rest);
      break;
    }
    const budget = Math.max(1, limit - prefix.length - CLOSE.length);
    const { cut, skip } = bestCut(rest, budget);
    const piece = rest.slice(0, Math.max(1, cut));
    rest = rest.slice(Math.max(1, cut) + (cut === 0 ? 0 : skip));
    const after = fenceStateAfter(piece, open);
    parts.push(prefix + piece + (after === null ? "" : CLOSE));
    open = after;
  }
  return parts.filter((p) => p.length > 0);
}

/** Prefix every line with `> ` (empty lines carry a zero-width space so the quote holds). */
export function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line.length === 0 ? "\u200b" : line}`)
    .join("\n");
}

/**
 * Quote `text` under `label`, middle-truncating the RAW text until the whole
 * message fits `budget` (the thinking message: shown in full unless it
 * would exceed the limit).
 */
export function labelledQuote(label: string, text: string, budget: number): string {
  const head = `${label}\n`;
  let maxRaw = budget - head.length;
  for (let i = 0; i < 20; i++) {
    const body = quote(middleTruncate(text, Math.max(0, maxRaw)));
    const out = head + body;
    if (out.length <= budget || maxRaw <= 0) return out.slice(0, budget);
    maxRaw -= out.length - budget;
  }
  return (head + quote(middleTruncate(text, 0))).slice(0, budget);
}

/**
 * Quote `text` under `label` LOSSLESSLY, splitting into as many messages as
 * needed (the echo of a prompt typed elsewhere — user text is never cut).
 * Each over-long line is chunked so every part stays a valid quote.
 */
export function splitQuoted(
  label: string,
  text: string,
  limit: number = DISCORD_MESSAGE_LIMIT,
): string[] {
  // Leave room for the label so the first quoted line always joins it.
  const lineMax = Math.max(1, limit - label.length - 3);
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      lines.push("> \u200b");
      continue;
    }
    let rest = raw;
    while (rest.length > 0) {
      const cut = rest.length <= lineMax ? rest.length : safeCut(rest, lineMax);
      lines.push(`> ${rest.slice(0, cut)}`);
      rest = rest.slice(cut);
    }
  }
  const parts: string[] = [];
  let current = label;
  for (const line of lines) {
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (next.length > limit) {
      parts.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

// ─── Tool messages ───────────────────────────────────────────────────────────

const SUMMARY_KEYS = [
  "command",
  "cmd",
  "path",
  "file_path",
  "filePath",
  "url",
  "query",
  "pattern",
  "name",
  "skill",
  "task",
  "prompt",
  "text",
] as const;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Truncate at the END with an ellipsis (for one-line summaries only). */
function endTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, safeCut(text, max - 1))}…`;
}

/**
 * A one-line, inline-code-safe summary of a tool call's input: the most
 * telling string field (`command`, `path`, `url`, …) when present, else the
 * compact JSON. Backticks are replaced so the summary cannot break out of
 * its inline code span.
 */
export function summarizeToolInput(input: unknown, max: number = TOOL_SUMMARY_MAX): string {
  let raw: string;
  if (typeof input === "string") {
    raw = input;
  } else if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    const key = SUMMARY_KEYS.find((k) => typeof rec[k] === "string" && rec[k] !== "");
    raw = key === undefined ? safeJson(input) : (rec[key] as string);
  } else {
    raw = safeJson(input);
  }
  return endTruncate(oneLine(raw).replace(/`/g, "ˋ"), max);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** `🔧 **shell** · \`ls -la\`` (the summary segment is omitted when empty). */
export function toolHeader(toolName: string, summary: string): string {
  const name = toolName.replace(/\*/g, "\\*");
  return summary.length === 0 ? `🔧 **${name}**` : `🔧 **${name}** · \`${summary}\``;
}

/** `✅ 1.2s` / `❌ 0.4s` (duration omitted when unknown, e.g. in replay). */
export function toolOutcome(isError: boolean, durationMs: number | undefined): string {
  const mark = isError ? "❌" : "✅";
  const dur = formatToolDuration(durationMs);
  return dur === null ? mark : `${mark} ${dur}`;
}

/** Neutralise triple backticks so tool output cannot close its code block. */
function escapeFence(text: string): string {
  return text.replace(/```/g, "`\u200b``");
}

/**
 * The tool result as a code block, middle-truncated so the WHOLE message
 * (`prefix` + block) stays within `budget`.
 */
export function toolResultBlock(content: string, prefixLength: number, budget: number): string {
  const body = content.length === 0 ? "(no output)" : escapeFence(content.replace(/\s+$/, ""));
  const overhead = prefixLength + "\n```\n".length + "\n```".length;
  const room = Math.max(0, budget - overhead);
  return `\n\`\`\`\n${middleTruncate(body, room)}\n\`\`\``;
}

// ─── Notices ─────────────────────────────────────────────────────────────────

const SECRETISH: readonly RegExp[] = [
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(sk|oc_sk|stlzi|pk|rk|xox[abpr])[-_][A-Za-z0-9_-]{8,}/g,
  /\b(api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/**
 * An error message made safe to post: secret-looking substrings masked,
 * collapsed to one line, capped in length. Discord mentions are already
 * disabled by Felicity (`allowedMentions: { parse: [] }`).
 */
export function sanitizeError(message: string, max = 300): string {
  let out = oneLine(message);
  out = out.replace(SECRETISH[0] as RegExp, "$1 …redacted…");
  out = out.replace(SECRETISH[1] as RegExp, "…redacted…");
  out = out.replace(SECRETISH[2] as RegExp, "$1$2…redacted…");
  out = out.replace(/`/g, "ˋ");
  return endTruncate(out.length === 0 ? "unknown error" : out, max);
}
