/**
 * Pure decision logic for agent management (plan P2: functional core).
 *
 * Validation, default resolution, access decisions, short-ID resolution,
 * result formatting, and text extraction live HERE — zero I/O, zero injected
 * effects. The service shell (`service.ts`) wires the stores/orchestrator and
 * calls these. Every function is (input → output) and tests directly without
 * mocks.
 */

import type { ChatMessage, ConversationMeta, ConversationStatus } from "@dispatch/kernel";
import type {
  AgentEntry,
  AgentManagementError,
  NamedAgentEntry,
  ReadAgentResult,
  SummonAgentResult,
} from "./types.js";
import { ok } from "./types.js";

// ─── Short IDs ──────────────────────────────────────────────────────────────

/** Minimum length of a short-ID prefix (plan §6.4: at least four characters). */
export const MIN_SHORT_ID_LEN = 4;

/** Number of leading characters used as a stable short ID in list output. */
export const SHORT_ID_PREFIX_LEN = 8;

/** A stable short ID (leading chars of the full conversation id). */
export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_PREFIX_LEN);
}

export type ShortIdResolution =
  | { readonly kind: "too-short" }
  | { readonly kind: "none" }
  | { readonly kind: "unique"; readonly id: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] };

/**
 * Resolve a short-ID prefix against an AUTHORIZED candidate set (plan §7.3).
 * Prefixes shorter than {@link MIN_SHORT_ID_LEN} are rejected. Only candidate
 * IDs that start with the prefix are considered — the caller never learns about
 * conversations outside its authorized set.
 */
export function resolveShortId(candidates: readonly string[], prefix: string): ShortIdResolution {
  if (prefix.length < MIN_SHORT_ID_LEN) return { kind: "too-short" };
  const matched = candidates.filter((id) => id.startsWith(prefix));
  if (matched.length === 0) return { kind: "none" };
  if (matched.length === 1) {
    const id = matched[0];
    if (id !== undefined) return { kind: "unique", id };
    return { kind: "none" };
  }
  return { kind: "ambiguous", candidates: matched };
}

// ─── Last assistant reply (thinking excluded) ───────────────────────────────

/**
 * Extract the last assistant message's last `type === "text"` chunk — the
 * "latest response" affordance for `read_agent`. Structurally excludes
 * `thinking` chunks (and tool-call/result/error chunks): only `text` is
 * selected, so private reasoning never reaches the parent (plan §6.4).
 *
 * Mirrors the `extractLastAssistantText` precedent in transport-http, but lives
 * here (not imported from transport-http) to avoid an unnatural
 * standard-extension → HTTP-transport dependency.
 */
export function extractLastAssistantReply(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined || msg.role !== "assistant") continue;
    for (let j = msg.chunks.length - 1; j >= 0; j--) {
      const chunk = msg.chunks[j];
      if (chunk !== undefined && chunk.type === "text") {
        return chunk.text;
      }
    }
    return "";
  }
  return "";
}

/**
 * Extract the last error chunk's message from the last assistant message, if
 * any. Used after a waited turn settles: an empty reply + a present error
 * signals a child-turn/provider failure (plan §8.5 `child-turn-failed`).
 */
export function extractLastError(messages: readonly ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined || msg.role !== "assistant") continue;
    for (const chunk of msg.chunks) {
      if (chunk.type === "error") return chunk.message;
    }
    return undefined;
  }
  return undefined;
}

// ─── Truncation ─────────────────────────────────────────────────────────────

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}…`, truncated: true };
}

// ─── Named Agent list filtering ─────────────────────────────────────────────

/**
 * Filter and bound a list of {@link NamedAgentEntry} (already built from the
 * local Named Agent registry by the shell). Preserves the registry's stable
 * case-insensitive name order. `query` is a case-insensitive substring filter
 * over the Named Agent NAME (not the raw model — agents summon by friendly
 * name). `limit` caps the result count. No vision filter: no local metadata
 * supports it, and reintroducing it would require the slow catalog scan the
 * Named Agent path exists to avoid (plan §8.1).
 */
export function filterNamedAgentEntries(
  entries: readonly NamedAgentEntry[],
  opts: { readonly query?: string; readonly limit: number },
): NamedAgentEntry[] {
  const q = opts.query?.trim();
  if (q === undefined || q.length === 0) return entries.slice(0, opts.limit);
  const needle = q.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().includes(needle)).slice(0, opts.limit);
}

// ─── File attachment composition ────────────────────────────────────────────

/**
 * Compose deterministic, labelled text after the task — the AI-tool analog of
 * the CLI `--file` flag (plan §9). Each file is fenced with labelled delimiters
 * in argument order; the task text comes first. Pure: the shell reads the
 * files (UTF-8 + containment); this only formats.
 */
export function formatFileAttachments(
  task: string,
  files: readonly { readonly path: string; readonly content: string }[],
): string {
  if (files.length === 0) return task;
  const parts: string[] = [task, ""];
  for (const f of files) {
    parts.push(`--- file: ${f.path} ---`);
    parts.push(f.content);
    parts.push(`--- end file: ${f.path} ---`);
    parts.push("");
  }
  return parts.join("\n");
}

// ─── Access decisions (plan §7) ─────────────────────────────────────────────

export type AccessOperation = "read" | "open" | "mutate";

/**
 * Decide whether the caller may perform `op` on a target, given whether the
 * target is the caller itself and whether it is a descendant of the caller.
 *
 * - Mutations (`send`, `cancel`) are limited to descendants (self is rejected —
 *   self-steering has the message queue / user-input paths; plan §7.4).
 * - `read`/`open` are allowed on descendants AND on the caller's own
 *   conversation (plan §7.2 point 3).
 */
export function decideAccess(
  op: AccessOperation,
  ctx: { readonly isSelf: boolean; readonly isDescendant: boolean },
): { readonly allowed: boolean; readonly reason?: string } {
  if (ctx.isDescendant) return { allowed: true };
  if (ctx.isSelf && (op === "read" || op === "open")) return { allowed: true };
  if (ctx.isSelf && op === "mutate") {
    return {
      allowed: false,
      reason: "cannot send to or cancel messages on your own conversation; use steering instead",
    };
  }
  return {
    allowed: false,
    reason: "target is not a descendant of the caller",
  };
}

// ─── Listing helpers ────────────────────────────────────────────────────────

/** Filter conversation metadata by a status set (no filter when undefined/empty). */
export function filterByStatus(
  metas: readonly ConversationMeta[],
  statuses: readonly ConversationStatus[] | undefined,
): ConversationMeta[] {
  if (statuses === undefined || statuses.length === 0) return [...metas];
  const set = new Set(statuses);
  return metas.filter((m) => set.has(m.status));
}

/** Filter conversation metadata by a case-insensitive title substring. */
export function filterByQuery(
  metas: readonly ConversationMeta[],
  query: string | undefined,
): ConversationMeta[] {
  const q = query?.trim();
  if (q === undefined || q.length === 0) return [...metas];
  const needle = q.toLowerCase();
  return metas.filter(
    (m) => m.title.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle),
  );
}

/** Sort conversation metadata by `lastActivityAt` descending (newest first). */
export function sortByActivityDesc(metas: readonly ConversationMeta[]): ConversationMeta[] {
  return [...metas].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/**
 * Build an {@link AgentEntry} from persisted metadata + the fetched model and
 * parent id + the manageable flag. Pure formatting (plan §6.3 concise fields).
 */
export function toAgentEntry(
  meta: ConversationMeta,
  model: string | null,
  parent: string | null,
  manageable: boolean,
): AgentEntry {
  return {
    conversationId: meta.id,
    shortId: shortId(meta.id),
    title: meta.title,
    status: meta.status,
    workspaceId: meta.workspaceId,
    createdAt: meta.createdAt,
    lastActivityAt: meta.lastActivityAt,
    manageable,
    ...(model !== null ? { model } : {}),
    ...(parent !== null ? { parentConversationId: parent } : {}),
  };
}

// ─── Parameter parsing ──────────────────────────────────────────────────────

/** Clamp a limit to `[1, max]`, defaulting to `def` when absent/invalid. */
export function clampLimit(value: number | undefined, def: number, max: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return def;
  return Math.min(value, max);
}

/** Parse a `toolAccess` value; `undefined` defaults to `"all"`. */
export function parseToolAccess(
  value: unknown,
): { readonly mode: "all" | "none" } | { readonly error: string } {
  if (value === undefined || value === null) return { mode: "all" };
  if (value === "all" || value === "none") return { mode: value };
  return { error: "'toolAccess' must be 'all' or 'none'" };
}

// ─── Result formatting (for tools) ──────────────────────────────────────────

/** Format a typed error into a tool-result content string. */
export function formatError(error: AgentManagementError): string {
  const base = `Error [${error.code}]: ${error.message}`;
  if (error.candidates !== undefined && error.candidates.length > 0) {
    return `${base}\nAmbiguous — candidates:\n${error.candidates
      .map((c) => `  ${c}`)
      .join("\n")}\nProvide more characters to disambiguate.`;
  }
  return base;
}

/**
 * Format `list_agent_models` output. Lists the Named Agents available for
 * `summon_agent` (plan §8.1) — NOT the raw provider catalog. Each line shows
 * the friendly name and the resolved canonical model it is bound to. An empty
 * list returns immediate setup guidance rather than falling back to the raw
 * catalog.
 */
export function formatListModelsResult(result: {
  readonly models: readonly NamedAgentEntry[];
}): string {
  if (result.models.length === 0) {
    return (
      "No named agents are configured. Ask the user to add one in the Named Agents " +
      "sidebar view."
    );
  }
  const lines = result.models.map((m) => `  ${m.name} (${m.model})`);
  return `Available named agents (${result.models.length}):\n${lines.join("\n")}`;
}

export function formatSummonResult(r: SummonAgentResult): string {
  const head = `Summoned agent ${shortId(r.conversationId)} (conversationId: ${r.conversationId}) in workspace "${r.workspaceId}". Status: ${r.status}. Started: ${r.started}.`;
  if (r.waitTimeout === true) {
    return `${head}\nWait timed out — the agent is still running. Use read_agent to check its reply later.`;
  }
  if (r.waitCancelled === true) {
    return `${head}\nWait cancelled by the parent — the agent is still running. Use read_agent to check its reply later.`;
  }
  if (r.reply !== undefined) {
    const note = r.truncated === true ? " (truncated)" : "";
    return `${head}\nFinal reply${note}:\n${r.reply}`;
  }
  return head;
}

export function formatListAgentsResult(r: {
  readonly agents: readonly AgentEntry[];
  readonly truncated: boolean;
}): string {
  if (r.agents.length === 0) return "No agents found.";
  const lines = r.agents.map((a) => {
    const parts = [`${a.shortId}`, `(id: ${a.conversationId})`];
    parts.push(`"${a.title}"`);
    if (a.model !== undefined) parts.push(`model=${a.model}`);
    parts.push(`status=${a.status}`);
    parts.push(`ws=${a.workspaceId}`);
    if (a.parentConversationId !== undefined)
      parts.push(`parent=${shortId(a.parentConversationId)}`);
    parts.push(a.manageable ? "manageable" : "read-only");
    return `  ${parts.join(" ")}`;
  });
  const tail = r.truncated ? "\n(results truncated — increase limit or narrow the query)" : "";
  return `Agents (${r.agents.length}):\n${lines.join("\n")}${tail}`;
}

export function formatReadAgentResult(r: ReadAgentResult): string {
  const head = `Agent ${shortId(r.conversationId)} (id: ${r.conversationId}). Status: ${r.status}.`;
  const flags: string[] = [];
  if (r.waitTimeout === true) flags.push("wait timed out");
  if (r.waitCancelled === true) flags.push("wait cancelled");
  if (r.truncated) flags.push("truncated");
  const flagNote = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  if (r.reply.length === 0) return `${head}${flagNote}\n(No assistant text yet.)`;
  return `${head}${flagNote}\n${r.reply}`;
}

export function formatSendAgentResult(r: {
  readonly conversationId: string;
  readonly delivered: "started-turn" | "queued";
  readonly messageId?: string;
  readonly reply?: string;
  readonly truncated?: boolean;
  readonly waitTimeout?: boolean;
  readonly waitCancelled?: boolean;
}): string {
  if (r.delivered === "queued") {
    const id = r.messageId !== undefined ? ` messageId=${r.messageId}` : "";
    return `Message queued for agent ${shortId(r.conversationId)} (id: ${r.conversationId}).${id} Use read_agent after it is delivered.`;
  }
  const head = `Message delivered — new turn started for agent ${shortId(r.conversationId)} (id: ${r.conversationId}).`;
  if (r.waitTimeout === true) {
    return `${head}\nWait timed out — the agent is still running. Use read_agent to check its reply later.`;
  }
  if (r.waitCancelled === true) {
    return `${head}\nWait cancelled by the parent — the agent is still running. Use read_agent to check its reply later.`;
  }
  if (r.reply !== undefined) {
    const note = r.truncated === true ? " (truncated)" : "";
    return `${head}\nFinal reply${note}:\n${r.reply}`;
  }
  return head;
}

export function formatCancelAgentMessageResult(r: {
  readonly conversationId: string;
  readonly cancelled: boolean;
  readonly queueLength: number;
}): string {
  if (r.cancelled) {
    return `Cancelled queued message for agent ${shortId(r.conversationId)}. Queue length is now ${r.queueLength}.`;
  }
  return `Message was not cancelled (already delivered, cancelled, or unknown) for agent ${shortId(
    r.conversationId,
  )}. Queue length is ${r.queueLength}.`;
}

export function formatOpenAgentResult(r: {
  readonly conversationId: string;
  readonly workspaceId: string;
}): string {
  return `Opened agent ${shortId(r.conversationId)} (id: ${r.conversationId}) in workspace "${r.workspaceId}".`;
}

/** Convenience re-export so tools can build success results tersely. */
export { ok };
