import { resolve as pathResolve } from "node:path";
import type {
  ChatMessage,
  Chunk,
  ConversationMeta,
  ConversationStatus,
  Logger,
  ReasoningEffort,
  Role,
  StorageNamespace,
  StoredChunk,
  TurnMetrics,
} from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import type { Workspace, WorkspaceEntry } from "@dispatch/wire";
import {
  CONVERSATION_INDEX_KEY,
  chunkKey,
  chunkPrefix,
  compactThresholdKey,
  computerKey,
  cwdKey,
  imageTranscriptionsKey,
  metaKey,
  metricsKey,
  metricsPrefix,
  metricsSeqKey,
  modelKey,
  parseSeq,
  reasoningEffortKey,
  seqKey,
  VISION_SETTINGS_KEY,
  workspaceKey,
} from "./keys.js";
import { reconcileWithReport } from "./reconcile.js";

export interface ConversationStore {
  readonly append: (conversationId: string, messages: readonly ChatMessage[]) => Promise<void>;
  readonly load: (conversationId: string) => Promise<ChatMessage[]>;
  /**
   * Read the conversation's persisted chunks as a SELECTION + optional WINDOW,
   * ascending by seq. The raw append-order log; NOT reconciled (a dangling
   * tool-call is returned as-is — repair is a turn-path concern).
   *
   * - **Selection** — `sinceSeq` is an exclusive lower bound (`seq > sinceSeq`;
   *   omitted/`0`/non-positive/non-integer = from the start). When
   *   `window.beforeSeq` is given it is an exclusive upper bound
   *   (`seq < beforeSeq`). Together: `sinceSeq < seq < beforeSeq`.
   * - **Window** — `window.limit` returns only the NEWEST `limit` chunks of the
   *   selection; the result STAYS ASCENDING by seq. A selection with ≤ `limit`
   *   chunks is returned whole (exact, not truncated).
   * - **Omitted = unchanged** — `window` absent (or both its fields undefined)
   *   is byte-identical to the pre-windowing behavior, so existing callers that
   *   pass no third argument are unaffected.
   * - **Garbage-in is forgiving** — a non-positive or non-integer `limit` (or
   *   `beforeSeq`) is treated as ABSENT (full selection); this method never
   *   throws on bad window input. The transport validates and 400s upstream.
   *
   * Seq numbering is 1-based and gap-free, so a client derives "older chunks
   * exist" purely from the oldest returned `seq > 1`; there is deliberately no
   * `earliestSeq`/high-water-mark API.
   */
  readonly loadSince: (
    conversationId: string,
    sinceSeq?: number,
    window?: { readonly beforeSeq?: number; readonly limit?: number },
  ) => Promise<readonly StoredChunk[]>;
  readonly appendMetrics: (conversationId: string, metrics: TurnMetrics) => Promise<void>;
  readonly loadMetrics: (conversationId: string) => Promise<readonly TurnMetrics[]>;
  /** The persisted working directory for a conversation, or null if never set. */
  readonly getCwd: (conversationId: string) => Promise<string | null>;
  /** Persist (upsert) the working directory for a conversation. */
  readonly setCwd: (conversationId: string, cwd: string) => Promise<void>;
  /** Clear (delete) the persisted working directory for a conversation. */
  readonly clearCwd: (conversationId: string) => Promise<void>;
  /**
   * The persisted computer (SSH config `Host` alias) for a conversation, or
   * `null` if never set (local). The computer analog of `getCwd`.
   */
  readonly getComputerId: (conversationId: string) => Promise<string | null>;
  /**
   * Persist (upsert) the computer for a conversation. Passing `null` clears
   * the persisted selection (idempotent) — `null` is the "local" sentinel
   * (no SSH), so it must NOT linger to shadow the workspace default. Mirrors
   * `setModel`'s clear-on-sentinel pattern (the computer analog of `setCwd`).
   */
  readonly setComputerId: (conversationId: string, alias: string | null) => Promise<void>;
  /** Clear (delete) the persisted computer for a conversation. */
  readonly clearComputerId: (conversationId: string) => Promise<void>;
  /** The persisted reasoning-effort level for a conversation, or null if never set. */
  readonly getReasoningEffort: (conversationId: string) => Promise<ReasoningEffort | null>;
  /** Persist (upsert) the reasoning-effort level for a conversation. */
  readonly setReasoningEffort: (conversationId: string, effort: ReasoningEffort) => Promise<void>;
  /** The persisted model name for a conversation, or null if never set. */
  readonly getModel: (conversationId: string) => Promise<string | null>;
  /**
   * Persist (upsert) the model name for a conversation (a model name in
   * `<credentialName>/<model>` form). Passing an empty string clears the
   * persisted selection (idempotent) — this is how transport-http clears via
   * `PUT /conversations/:id/model` with a `null` body.
   */
  readonly setModel: (conversationId: string, model: string) => Promise<void>;
  /**
   * List all known conversations, sorted by `lastActivityAt` descending (most
   * recent first). Metadata (createdAt, lastActivityAt, title) is tracked
   * automatically on append; title defaults to the first user message.
   */
  readonly listConversations: (filter?: {
    readonly status?: readonly ConversationStatus[];
    readonly workspaceId?: string;
  }) => Promise<readonly ConversationMeta[]>;
  /** Single conversation metadata, or null if unknown. */
  readonly getConversationMeta: (conversationId: string) => Promise<ConversationMeta | null>;
  /** Set/update the human-readable title for a conversation. */
  readonly setConversationTitle: (conversationId: string, title: string) => Promise<void>;
  /** Get the lifecycle status of a conversation, or null if unknown. */
  readonly getConversationStatus: (conversationId: string) => Promise<ConversationStatus | null>;
  /** Set the lifecycle status of a conversation. Creates a minimal metadata row if missing. */
  readonly setConversationStatus: (
    conversationId: string,
    status: ConversationStatus,
  ) => Promise<void>;
  /**
   * Replace the entire conversation history with the given messages. Deletes
   * all existing chunks, resets the seq counter, and appends the new messages.
   * Used by compaction to replace old history with a summary + recent messages.
   * Metadata (createdAt, title, status) is preserved.
   */
  readonly replaceHistory: (
    conversationId: string,
    messages: readonly ChatMessage[],
  ) => Promise<void>;
  /**
   * Fork (copy) the full conversation history from `sourceId` to `targetId`.
   * Copies all chunks, metadata, cwd, reasoning-effort, and model. The
   * target's status is set to "closed" (it's an archive) and `compactedFrom`
   * is set to `sourceId`. Used by compaction to preserve the pre-compaction
   * history non-destructively before replacing it with a summary.
   */
  readonly forkHistory: (sourceId: string, targetId: string) => Promise<void>;
  /** Get the compact percent (0-100, 0 = manual only), or null if unset. */
  readonly getCompactPercent: (conversationId: string) => Promise<number | null>;
  /** Set the compact percent (0-100, 0 = manual only). */
  readonly setCompactPercent: (conversationId: string, percent: number) => Promise<void>;
  /**
   * Get the per-conversation image transcription cache: a map of image URL →
   * transcription text. Used by the vision handoff to avoid re-transcribing
   * old images that were compacted to text on a previous turn. Returns an
   * empty map when none are cached.
   */
  readonly getImageTranscriptions: (conversationId: string) => Promise<ReadonlyMap<string, string>>;
  /**
   * Upsert a single image transcription into the per-conversation cache.
   * Merges with any existing transcriptions (does NOT replace the whole map).
   */
  readonly setImageTranscription: (
    conversationId: string,
    imageUrl: string,
    transcription: string,
  ) => Promise<void>;
  /**
   * Get the global vision settings (image compaction limit + compaction model).
   * The limit defaults to 10 when never set; the compaction model defaults to
   * null (auto-select). Shared across ALL conversations and vision models.
   */
  readonly getVisionSettings: () => Promise<{
    readonly imageLimit: number;
    readonly compactionModel: string | null;
  }>;
  /** Set the global vision image compaction limit (0 = disabled). */
  readonly setVisionImageLimit: (limit: number) => Promise<void>;
  /** Set the global vision compaction model (null = auto-select). */
  readonly setVisionCompactionModel: (model: string | null) => Promise<void>;
  /**
   * Set the `compactedFrom` field on a conversation's metadata, pointing to
   * the archive conversation that holds the pre-compaction history.
   */
  readonly setCompactedFrom: (conversationId: string, newConversationId: string) => Promise<void>;
  /**
   * Returns the workspace, or synthesizes `"default"` if `id === "default"`
   * and it was never persisted (title `"default"`, defaultCwd `null`,
   * timestamps `0`). Returns `null` for any other non-existent id.
   */
  readonly getWorkspace: (id: string) => Promise<Workspace | null>;
  /**
   * Create-on-miss: if absent, create with `title = opts.title ?? id`,
   * `defaultCwd = opts.defaultCwd ?? null`, `createdAt/lastActivityAt = now`.
   * If present, return as-is (ignore `opts`). The `"default"` workspace is
   * always returned as-is (never re-created). This is the `PUT
   * /workspaces/:id` handler.
   */
  readonly ensureWorkspace: (
    id: string,
    opts?: {
      readonly title?: string;
      readonly defaultCwd?: string | null;
      readonly defaultComputerId?: string | null;
    },
  ) => Promise<Workspace>;
  /** Rename a workspace. Creates the workspace if missing. */
  readonly setWorkspaceTitle: (id: string, title: string) => Promise<Workspace>;
  /** Set/clear a workspace's default cwd. Creates the workspace if missing. */
  readonly setWorkspaceDefaultCwd: (id: string, defaultCwd: string | null) => Promise<Workspace>;
  /**
   * Set/clear a workspace's default computer (SSH alias). Creates the
   * workspace if missing. The computer analog of `setWorkspaceDefaultCwd`.
   * `null` = local (no SSH).
   */
  readonly setWorkspaceDefaultComputerId: (
    id: string,
    defaultComputerId: string | null,
  ) => Promise<Workspace>;
  /**
   * Star or unstar a workspace. Creates the workspace if missing (like
   * `setWorkspaceTitle`). Starred workspaces receive PRIORITY in the
   * concurrency limiter queue — their agents jump ahead of agents from
   * non-starred workspaces (oldest-agent-first within each group).
   */
  readonly setWorkspaceStarred: (id: string, starred: boolean) => Promise<Workspace>;
  /**
   * Delete a workspace: (1) find all conversations with `workspaceId === id`,
   * (2) set each to `status = "closed"` and reassign `workspaceId = "default"`,
   * (3) delete the workspace entity. Returns `closedCount`. Throws if `id
   * === "default"`.
   */
  readonly deleteWorkspace: (id: string) => Promise<{ closedCount: number }>;
  /**
   * All workspaces sorted by `lastActivityAt` descending. Each entry includes
   * `conversationCount`. Always includes `"default"` (synthesized if not
   * persisted, with the count of legacy/unassigned conversations).
   */
  readonly listWorkspaces: () => Promise<readonly WorkspaceEntry[]>;
  /**
   * Returns the conversation's workspaceId, or `"default"` if the
   * conversation has no workspaceId persisted (or doesn't exist).
   */
  readonly getWorkspaceId: (conversationId: string) => Promise<string>;
  /**
   * Persist the conversation's workspace assignment. If the conversation
   * doesn't exist yet, create a minimal metadata row (like
   * `setConversationStatus` does).
   */
  readonly setWorkspaceId: (conversationId: string, workspaceId: string) => Promise<void>;
  /**
   * Resolve the effective working directory for a conversation:
   *
   * 1. **Absolute conversation cwd** — an explicit per-conversation cwd
   *    (`getCwd`, or `overrideCwd` when provided) that starts with `/`
   *    overrides outright.
   * 2. **Relative conversation cwd** — an explicit cwd that does NOT start
   *    with `/` is resolved against the workspace `defaultCwd` (or
   *    `serverDefaultCwd` when the workspace has no `defaultCwd`) via
   *    `path.resolve`.
   * 3. **No conversation cwd** — the workspace `defaultCwd` is used.
   * 4. **Neither set** — the `serverDefaultCwd` (defaulting to
   *    `process.cwd()` at construction time) is used.
   *
   * The workspace is resolved via `getWorkspaceId` (falling back to
   * `"default"`) + `getWorkspace`.
   *
   * @param overrideCwd — an explicit cwd to resolve INSTEAD of the persisted
   *   `getCwd` value. When provided (not `undefined`), it is fed through the
   *   same algorithm above (absolute → returned as-is; relative → resolved
   *   against the workspace `defaultCwd`). Used by the session-orchestrator
   *   for a per-turn cwd override (sent by the client on `chat.send`) so a
   *   transient relative cwd is resolved the same way a persisted one is,
   *   instead of being resolved against `process.cwd()`. When omitted, the
   *   persisted `getCwd` is read as today.
   */
  readonly getEffectiveCwd: (
    conversationId: string,
    overrideCwd?: string,
  ) => Promise<string | null>;
  /**
   * Resolve the effective computer (SSH alias) for a conversation — the
   * computer analog of `getEffectiveCwd`. Resolution ladder:
   *
   * 1. **overrideAlias** — an explicit per-turn alias (from `chat.send`)
   *    wins outright, EVEN when `null` (explicitly local for this turn — it
   *    does NOT fall through).
   * 2. **Persisted per-conversation `computerId`** — `getComputerId`.
   * 3. **Workspace `defaultComputerId`** — resolved via `getWorkspaceId`
   *    (falling back to `"default"`) + `getWorkspace`.
   * 4. **None of the above** — `null` (LOCAL: no SSH, today's behavior).
   *
   * Returns the alias STRING (or `null`); it does NOT validate the alias
   * exists in `~/.ssh/config` (validation happens at connect time — a stale
   * alias yields a clear connect error rather than silently falling back to
   * local).
   *
   * @param overrideAlias — an explicit alias to resolve INSTEAD of the
   *   persisted `getComputerId` value. When provided (not `undefined`), it
   *   is returned as-is (string or `null`), short-circuiting the rest of the
   *   ladder. Used by the session-orchestrator for a per-turn computer
   *   override (sent by the client on `chat.send`). When omitted, the
   *   persisted `getComputerId` is read as today.
   */
  readonly getEffectiveComputer: (
    conversationId: string,
    overrideAlias?: string | null,
  ) => Promise<string | null>;
}

export const conversationStoreHandle = defineService<ConversationStore>("conversation-store/store");

/**
 * Coerce a window bound to a positive integer, or `undefined` (= absent) for any
 * non-positive / non-integer / undefined input. Keeps `loadSince` total.
 */
function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/**
 * Coerce `sinceSeq` to a non-negative integer lower bound, honoring the
 * contract's stated forgivingness for DIRECT callers: omitted / `0` /
 * non-positive / non-integer (incl. `NaN`/`Infinity`) all → `0` (= "from the
 * start"). A valid non-negative integer is returned as-is. The transport layer
 * 400s these upstream, but `loadSince` stays total on its own. Keeps `loadSince`
 * byte-identical to the prior `?? 0` behavior for the only values any caller
 * ever passed (omitted / `0` / non-negative integers).
 */
function sinceSeqBase(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

interface PersistedChunkEntry {
  readonly chunk: Chunk;
  readonly role: Role;
  readonly msgIdx: number;
  readonly chunkIdx: number;
}

/**
 * The persisted shape of a conversation's metadata (JSON at `metaKey(id)`).
 * Maps to `ConversationMeta` (from `@dispatch/wire`) by adding the `id`.
 */
interface ConversationMetaRow {
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly compactedFrom?: string;
  /**
   * The workspace this conversation belongs to. Absent on legacy rows
   * (read as `"default"`). Persisted only when explicitly assigned.
   */
  readonly workspaceId?: string;
}

/**
 * The persisted shape of a `Workspace` (JSON at `workspaceKey(id)`). The `id`
 * is the key, so it is not duplicated in the row.
 */
interface WorkspaceRow {
  readonly title: string;
  readonly defaultCwd: string | null;
  /**
   * The workspace's default computer (SSH config `Host` alias) — the computer
   * analog of `defaultCwd`. `null` = local (no SSH). Conversations in this
   * workspace inherit it when they set no `computerId` of their own.
   */
  readonly defaultComputerId: string | null;
  /**
   * Whether the workspace is starred by the user. Starred workspaces receive
   * PRIORITY in the concurrency limiter queue. Defaults to `false` on legacy
   * rows (normalized by `parseWorkspaceRow`).
   */
  readonly starred: boolean;
  readonly createdAt: number;
  readonly lastActivityAt: number;
}

/** Maximum title length (in characters) before truncation with an ellipsis. */
const TITLE_MAX = 80;

/**
 * Derive a human-readable title from a batch of messages: the text of the
 * first `role: "user"` message's first `type: "text"` chunk, truncated to
 * {@link TITLE_MAX} characters with a trailing `"…"` when longer. Returns
 * `"Untitled"` when no user text chunk is present.
 *
 * Pure (input → output); exported so callers can preview a title without
 * persisting.
 */
export function extractTitle(messages: readonly ChatMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const chunk of msg.chunks) {
      if (chunk.type === "text") {
        return chunk.text.length > TITLE_MAX ? `${chunk.text.slice(0, TITLE_MAX)}…` : chunk.text;
      }
    }
  }
  return "Untitled";
}

/**
 * Parse a persisted {@link ConversationMetaRow}, returning `null` on any
 * parse / shape failure so callers can treat a corrupt row as missing.
 */
function parseMetaRow(raw: string): ConversationMetaRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as ConversationMetaRow).createdAt !== "number" ||
    typeof (parsed as ConversationMetaRow).lastActivityAt !== "number" ||
    typeof (parsed as ConversationMetaRow).title !== "string"
  ) {
    return null;
  }
  const row = parsed as ConversationMetaRow;
  const status: ConversationStatus =
    row.status === "active" || row.status === "closed" ? row.status : "idle";
  return {
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    title: row.title,
    status,
    ...(row.compactedFrom !== undefined ? { compactedFrom: row.compactedFrom } : {}),
    ...(row.workspaceId !== undefined ? { workspaceId: row.workspaceId } : {}),
  };
}

function toMeta(id: string, row: ConversationMetaRow): ConversationMeta {
  return {
    id,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    title: row.title,
    status: row.status,
    workspaceId: row.workspaceId ?? "default",
    ...(row.compactedFrom !== undefined ? { compactedFrom: row.compactedFrom } : {}),
  };
}

/**
 * Validate a workspace slug: 1–40 chars, lowercase alphanumeric + internal
 * hyphens (must start and end alphanumeric). The transport layer calls this
 * to validate before hitting the store. Pure (input → boolean).
 */
export function isValidWorkspaceSlug(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id);
}

/** The always-present, non-deletable default workspace id. */
const DEFAULT_WORKSPACE_ID = "default";

/**
 * Parse a persisted {@link WorkspaceRow}, returning `null` on any parse /
 * shape failure so callers can treat a corrupt row as missing.
 */
function parseWorkspaceRow(raw: string): WorkspaceRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as WorkspaceRow).title !== "string" ||
    typeof (parsed as WorkspaceRow).createdAt !== "number" ||
    typeof (parsed as WorkspaceRow).lastActivityAt !== "number"
  ) {
    return null;
  }
  const row = parsed as WorkspaceRow;
  // `defaultCwd` may be null OR a string; treat anything else as null.
  const defaultCwd = typeof row.defaultCwd === "string" ? row.defaultCwd : null;
  // `defaultComputerId` may be null OR a string; treat anything else as null
  // (mirrors `defaultCwd`). Absent on legacy rows → null (local).
  const defaultComputerId =
    typeof row.defaultComputerId === "string" ? row.defaultComputerId : null;
  // `starred` may be absent on legacy rows; treat anything non-boolean as false.
  const starred = row.starred === true;
  return {
    title: row.title,
    defaultCwd,
    defaultComputerId,
    starred,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
  };
}

function toWorkspace(id: string, row: WorkspaceRow): Workspace {
  return {
    id,
    title: row.title,
    defaultCwd: row.defaultCwd,
    defaultComputerId: row.defaultComputerId,
    starred: row.starred === true,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
  };
}

export function createConversationStore(
  storage: StorageNamespace,
  logger?: Logger,
  now: () => number = Date.now,
  serverDefaultCwd: string = process.cwd(),
): ConversationStore {
  /**
   * Add `conversationId` to the persisted index (idempotent). The store is
   * not highly concurrent — the session-orchestrator serializes turns per
   * conversation — so a simple read-modify-write suffices; `listConversations`
   * deduplicates on read in case of a race on this update.
   */
  async function ensureInIndex(conversationId: string): Promise<void> {
    const raw = await storage.get(CONVERSATION_INDEX_KEY);
    let ids: string[];
    if (raw === null) {
      ids = [];
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = [];
      }
      ids = Array.isArray(parsed) ? (parsed.filter((v) => typeof v === "string") as string[]) : [];
    }
    if (ids.includes(conversationId)) return;
    ids.push(conversationId);
    await storage.set(CONVERSATION_INDEX_KEY, JSON.stringify(ids));
  }

  /**
   * Read a persisted {@link WorkspaceRow} by id, or `null` if absent/corrupt.
   */
  async function readWorkspaceRow(id: string): Promise<WorkspaceRow | null> {
    const raw = await storage.get(workspaceKey(id));
    if (raw === null) return null;
    return parseWorkspaceRow(raw);
  }

  /**
   * Bump a workspace's `lastActivityAt` to `ts`. Creates the workspace row on
   * miss (with `title = id`, `defaultCwd = null`, `createdAt/lastActivityAt
   * = ts`) so that the first activity in any workspace — including the
   * synthesized `"default"` — is recorded. Does NOT touch `title` or
   * `defaultCwd` on an existing row.
   */
  async function bumpWorkspaceLastActivityAt(workspaceId: string, ts: number): Promise<void> {
    const existing = await readWorkspaceRow(workspaceId);
    const row: WorkspaceRow =
      existing === null
        ? {
            title: workspaceId,
            defaultCwd: null,
            defaultComputerId: null,
            starred: false,
            createdAt: ts,
            lastActivityAt: ts,
          }
        : {
            title: existing.title,
            defaultCwd: existing.defaultCwd,
            defaultComputerId: existing.defaultComputerId,
            starred: existing.starred,
            createdAt: existing.createdAt,
            lastActivityAt: ts,
          };
    await storage.set(workspaceKey(workspaceId), JSON.stringify(row));
  }

  return {
    async append(conversationId, messages) {
      const raw = await storage.get(seqKey(conversationId));
      let seq = parseSeq(raw) + 1;

      for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
        const msg = messages[msgIdx];
        if (msg === undefined) continue;
        for (let chunkIdx = 0; chunkIdx < msg.chunks.length; chunkIdx++) {
          const chunk = msg.chunks[chunkIdx];
          if (chunk === undefined) continue;
          const entry: PersistedChunkEntry = {
            chunk,
            role: msg.role,
            msgIdx,
            chunkIdx,
          };
          await storage.set(chunkKey(conversationId, seq), JSON.stringify(entry));
          seq++;
        }
      }

      await storage.set(seqKey(conversationId), String(seq - 1));

      // Metadata upsert: track createdAt/lastActivityAt/title and keep the
      // conversation discoverable in the index.
      const ts = now();
      let conversationWorkspaceId = DEFAULT_WORKSPACE_ID;
      const metaRaw = await storage.get(metaKey(conversationId));
      if (metaRaw === null) {
        const row: ConversationMetaRow = {
          createdAt: ts,
          lastActivityAt: ts,
          title: extractTitle(messages),
          status: "idle",
        };
        await storage.set(metaKey(conversationId), JSON.stringify(row));
        await ensureInIndex(conversationId);
      } else {
        const existing = parseMetaRow(metaRaw);
        if (existing === null) {
          // Corrupt row — rewrite from scratch using this append.
          const row: ConversationMetaRow = {
            createdAt: ts,
            lastActivityAt: ts,
            title: extractTitle(messages),
            status: "idle",
          };
          await storage.set(metaKey(conversationId), JSON.stringify(row));
          await ensureInIndex(conversationId);
        } else {
          conversationWorkspaceId = existing.workspaceId ?? DEFAULT_WORKSPACE_ID;
          const title =
            existing.title === "Untitled" || existing.title === ""
              ? extractTitle(messages)
              : existing.title;
          const row: ConversationMetaRow = {
            createdAt: existing.createdAt,
            lastActivityAt: ts,
            title,
            status: existing.status,
            ...(existing.compactedFrom !== undefined
              ? { compactedFrom: existing.compactedFrom }
              : {}),
            ...(existing.workspaceId !== undefined ? { workspaceId: existing.workspaceId } : {}),
          };
          await storage.set(metaKey(conversationId), JSON.stringify(row));
        }
      }
      // Bump the owning workspace's lastActivityAt to this append's time.
      await bumpWorkspaceLastActivityAt(conversationWorkspaceId, ts);
    },

    async load(conversationId) {
      const prefix = chunkPrefix(conversationId);
      const keys = await storage.keys(prefix);
      const sorted = [...keys].sort();

      const messages: ChatMessage[] = [];
      let currentChunks: Chunk[] = [];
      let currentRole: Role | undefined;
      let currentMsgIdx = -1;

      for (const key of sorted) {
        const value = await storage.get(key);
        if (value === null) continue;
        let entry: PersistedChunkEntry;
        try {
          entry = JSON.parse(value) as PersistedChunkEntry;
        } catch (err) {
          // "Never leave the system broken": a single corrupt/unparseable
          // row must not brick the whole conversation. Skip it (append-only
          // storage untouched) and let reconcile run on the rest. loadSince
          // is intentionally NOT hardened here — it is the raw FE read path.
          if (logger !== undefined) {
            logger.warn("skipping corrupt chunk row", {
              conversationId,
              key,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          continue;
        }

        if (entry.msgIdx !== currentMsgIdx) {
          if (currentMsgIdx >= 0 && currentRole !== undefined) {
            messages.push({ role: currentRole, chunks: currentChunks });
          }
          currentChunks = [];
          currentRole = entry.role;
          currentMsgIdx = entry.msgIdx;
        }

        currentChunks.push(entry.chunk);
      }

      if (currentMsgIdx >= 0 && currentRole !== undefined) {
        messages.push({ role: currentRole, chunks: currentChunks });
      }

      const { messages: repaired, report } = reconcileWithReport(messages);

      const hasReconcileActivity =
        report.repairedCount > 0 ||
        report.strippedErrorChunks > 0 ||
        report.droppedEmptyMessages > 0;
      if (hasReconcileActivity && logger !== undefined) {
        const child = logger.child({ conversationId });
        const span = child.span("reconcile.repair", {
          repairedCount: report.repairedCount,
          firstRepairedToolCallId: report.repairedToolCallIds[0] ?? null,
          strippedErrorChunks: report.strippedErrorChunks,
          droppedEmptyMessages: report.droppedEmptyMessages,
        });
        span.end();
      }

      return repaired;
    },

    async loadSince(conversationId, sinceSeq, window) {
      const prefix = chunkPrefix(conversationId);
      const keys = await storage.keys(prefix);
      const sorted = [...keys].sort();

      const result: StoredChunk[] = [];
      const minSeq = sinceSeqBase(sinceSeq);
      // Forgiving: a non-positive / non-integer bound is treated as ABSENT.
      const beforeSeq = positiveInt(window?.beforeSeq);
      const limit = positiveInt(window?.limit);

      for (const key of sorted) {
        const seq = parseSeq(key.split(":").pop() ?? null);
        if (seq <= minSeq) continue;
        if (beforeSeq !== undefined && seq >= beforeSeq) continue;
        const value = await storage.get(key);
        if (value === null) continue;
        const entry = JSON.parse(value) as PersistedChunkEntry;
        result.push({ seq, role: entry.role, chunk: entry.chunk });
      }

      // Window: keep only the NEWEST `limit` chunks, still ascending by seq.
      if (limit !== undefined && result.length > limit) {
        return result.slice(result.length - limit);
      }

      return result;
    },

    async appendMetrics(conversationId, metrics) {
      const raw = await storage.get(metricsSeqKey(conversationId));
      const ordinal = parseSeq(raw) + 1;
      await storage.set(metricsKey(conversationId, ordinal), JSON.stringify(metrics));
      await storage.set(metricsSeqKey(conversationId), String(ordinal));
    },

    async loadMetrics(conversationId) {
      const prefix = metricsPrefix(conversationId);
      const keys = await storage.keys(prefix);
      const sorted = [...keys].sort();

      const result: TurnMetrics[] = [];
      for (const key of sorted) {
        const value = await storage.get(key);
        if (value === null) continue;
        result.push(JSON.parse(value) as TurnMetrics);
      }

      return result;
    },

    async getCwd(conversationId) {
      return await storage.get(cwdKey(conversationId));
    },

    async setCwd(conversationId, cwd) {
      await storage.set(cwdKey(conversationId), cwd);
      if (logger !== undefined) {
        logger.debug("cwd set", { conversationId });
      }
    },

    async clearCwd(conversationId) {
      // Idempotent: deleting an already-absent key is a no-op (no error).
      await storage.delete(cwdKey(conversationId));
      if (logger !== undefined) {
        logger.debug("cwd cleared", { conversationId });
      }
    },

    async getComputerId(conversationId) {
      return await storage.get(computerKey(conversationId));
    },

    async setComputerId(conversationId, alias) {
      // `null` is the "local" sentinel: clear the persisted key so it does
      // NOT linger to shadow the workspace defaultComputerId. Idempotent
      // (deleting an already-absent key is a no-op). Mirrors `setModel`'s
      // clear-on-sentinel pattern.
      if (alias === null) {
        await storage.delete(computerKey(conversationId));
        if (logger !== undefined) {
          logger.debug("computer cleared", { conversationId });
        }
        return;
      }
      await storage.set(computerKey(conversationId), alias);
      if (logger !== undefined) {
        logger.debug("computer set", { conversationId });
      }
    },

    async clearComputerId(conversationId) {
      // Idempotent: deleting an already-absent key is a no-op (no error).
      await storage.delete(computerKey(conversationId));
      if (logger !== undefined) {
        logger.debug("computer cleared", { conversationId });
      }
    },

    async getReasoningEffort(conversationId) {
      return (await storage.get(reasoningEffortKey(conversationId))) as ReasoningEffort | null;
    },

    async setReasoningEffort(conversationId, effort) {
      await storage.set(reasoningEffortKey(conversationId), effort);
      if (logger !== undefined) {
        logger.debug("reasoning-effort set", { conversationId });
      }
    },

    async getModel(conversationId) {
      return await storage.get(modelKey(conversationId));
    },

    async setModel(conversationId, model) {
      if (model === "") {
        // Idempotent clear: an empty model clears the persisted
        // selection. Deleting an already-absent key is a no-op.
        await storage.delete(modelKey(conversationId));
        if (logger !== undefined) {
          logger.debug("model cleared", { conversationId });
        }
        return;
      }
      await storage.set(modelKey(conversationId), model);
      if (logger !== undefined) {
        logger.debug("model set", { conversationId });
      }
    },
    async listConversations(filter) {
      const raw = await storage.get(CONVERSATION_INDEX_KEY);
      if (raw === null) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      // Deduplicate (in case of a race on the index update) while preserving
      // first-seen order.
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const v of parsed) {
        if (typeof v !== "string" || seen.has(v)) continue;
        seen.add(v);
        ids.push(v);
      }

      const statusFilter = filter?.status;
      const workspaceFilter = filter?.workspaceId;
      const metas: ConversationMeta[] = [];
      for (const id of ids) {
        const metaRaw = await storage.get(metaKey(id));
        if (metaRaw === null) continue;
        const row = parseMetaRow(metaRaw);
        if (row === null) continue;
        if (statusFilter !== undefined && !statusFilter.includes(row.status)) continue;
        if (workspaceFilter !== undefined) {
          const wsId = row.workspaceId ?? DEFAULT_WORKSPACE_ID;
          if (wsId !== workspaceFilter) continue;
        }
        metas.push(toMeta(id, row));
      }
      // Sort by lastActivityAt descending (most recent first). Stable sort
      // keeps first-seen (index) order for ties.
      return metas.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    },

    async getConversationMeta(conversationId) {
      const raw = await storage.get(metaKey(conversationId));
      if (raw === null) return null;
      const row = parseMetaRow(raw);
      if (row === null) return null;
      return toMeta(conversationId, row);
    },

    async setConversationTitle(conversationId, title) {
      const ts = now();
      const raw = await storage.get(metaKey(conversationId));
      if (raw === null) {
        // Title set before any message was appended — create a minimal row.
        const row: ConversationMetaRow = {
          createdAt: ts,
          lastActivityAt: ts,
          title,
          status: "idle",
        };
        await storage.set(metaKey(conversationId), JSON.stringify(row));
        await ensureInIndex(conversationId);
        return;
      }
      const existing = parseMetaRow(raw);
      if (existing === null) {
        // Corrupt row — rewrite from scratch with this title.
        const row: ConversationMetaRow = {
          createdAt: ts,
          lastActivityAt: ts,
          title,
          status: "idle",
        };
        await storage.set(metaKey(conversationId), JSON.stringify(row));
        await ensureInIndex(conversationId);
        return;
      }
      // Preserve createdAt + lastActivityAt + status; update only the title.
      const row: ConversationMetaRow = {
        createdAt: existing.createdAt,
        lastActivityAt: existing.lastActivityAt,
        title,
        status: existing.status,
        ...(existing.compactedFrom !== undefined ? { compactedFrom: existing.compactedFrom } : {}),
        ...(existing.workspaceId !== undefined ? { workspaceId: existing.workspaceId } : {}),
      };
      await storage.set(metaKey(conversationId), JSON.stringify(row));
    },

    async getConversationStatus(conversationId) {
      const raw = await storage.get(metaKey(conversationId));
      if (raw === null) return null;
      const row = parseMetaRow(raw);
      if (row === null) return null;
      return row.status;
    },

    async setConversationStatus(conversationId, status) {
      const ts = now();
      const raw = await storage.get(metaKey(conversationId));
      if (raw === null) {
        // Status set before any message was appended — create a minimal row.
        const row: ConversationMetaRow = {
          createdAt: ts,
          lastActivityAt: ts,
          title: "Untitled",
          status,
        };
        await storage.set(metaKey(conversationId), JSON.stringify(row));
        await ensureInIndex(conversationId);
        return;
      }
      const existing = parseMetaRow(raw);
      if (existing === null) {
        const row: ConversationMetaRow = {
          createdAt: ts,
          lastActivityAt: ts,
          title: "Untitled",
          status,
        };
        await storage.set(metaKey(conversationId), JSON.stringify(row));
        await ensureInIndex(conversationId);
        return;
      }
      const row: ConversationMetaRow = {
        createdAt: existing.createdAt,
        lastActivityAt: existing.lastActivityAt,
        title: existing.title,
        status,
        ...(existing.compactedFrom !== undefined ? { compactedFrom: existing.compactedFrom } : {}),
        ...(existing.workspaceId !== undefined ? { workspaceId: existing.workspaceId } : {}),
      };
      await storage.set(metaKey(conversationId), JSON.stringify(row));
    },

    async replaceHistory(conversationId, messages) {
      // Delete all existing chunks.
      const keys = await storage.keys(chunkPrefix(conversationId));
      for (const k of keys) {
        await storage.delete(k);
      }
      // Reset the seq counter so the new messages start from seq 1.
      await storage.set(seqKey(conversationId), "0");
      // Append the new messages (re-uses the append logic for seq
      // numbering + metadata upsert).
      await this.append(conversationId, messages);
    },

    async forkHistory(sourceId, targetId) {
      // Copy all chunks from source to target, re-numbered from seq 1.
      const keys = await storage.keys(chunkPrefix(sourceId));
      const sorted = [...keys].sort();
      let seq = 1;
      for (const key of sorted) {
        const value = await storage.get(key);
        if (value === null) continue;
        await storage.set(chunkKey(targetId, seq), value);
        seq++;
      }
      await storage.set(seqKey(targetId), String(Math.max(seq - 1, 0)));

      // Copy metadata with archive title + closed status.
      // Inherit compactedFrom from the source so archives chain:
      // A → Y → X (each archive points to the previous one).
      const metaRaw = await storage.get(metaKey(sourceId));
      if (metaRaw !== null) {
        const existing = parseMetaRow(metaRaw);
        if (existing !== null) {
          const row: ConversationMetaRow = {
            createdAt: existing.createdAt,
            lastActivityAt: existing.lastActivityAt,
            title: `Archive: ${existing.title}`,
            status: "closed",
            ...(existing.compactedFrom !== undefined
              ? { compactedFrom: existing.compactedFrom }
              : {}),
            ...(existing.workspaceId !== undefined ? { workspaceId: existing.workspaceId } : {}),
          };
          await storage.set(metaKey(targetId), JSON.stringify(row));
        }
      }
      await ensureInIndex(targetId);

      // Copy cwd + reasoning-effort + model + computer (so the archive is self-contained).
      const cwd = await storage.get(cwdKey(sourceId));
      if (cwd !== null) await storage.set(cwdKey(targetId), cwd);
      const effort = await storage.get(reasoningEffortKey(sourceId));
      if (effort !== null) await storage.set(reasoningEffortKey(targetId), effort);
      const model = await storage.get(modelKey(sourceId));
      if (model !== null) await storage.set(modelKey(targetId), model);
      const computerId = await storage.get(computerKey(sourceId));
      if (computerId !== null) await storage.set(computerKey(targetId), computerId);
    },

    async getCompactPercent(conversationId) {
      const raw = await storage.get(compactThresholdKey(conversationId));
      if (raw === null) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isNaN(n) ? null : n;
    },

    async setCompactPercent(conversationId, percent) {
      await storage.set(compactThresholdKey(conversationId), String(percent));
      if (logger !== undefined) {
        logger.debug("compact-percent set", { conversationId, percent });
      }
    },

    async getImageTranscriptions(conversationId) {
      const raw = await storage.get(imageTranscriptionsKey(conversationId));
      if (raw === null) return new Map();
      try {
        const obj = JSON.parse(raw) as Record<string, string>;
        return new Map(Object.entries(obj));
      } catch {
        return new Map();
      }
    },

    async setImageTranscription(conversationId, imageUrl, transcription) {
      const existing = await this.getImageTranscriptions(conversationId);
      const merged = new Map(existing);
      merged.set(imageUrl, transcription);
      const obj: Record<string, string> = {};
      for (const [k, v] of merged) obj[k] = v;
      await storage.set(imageTranscriptionsKey(conversationId), JSON.stringify(obj));
    },

    async getVisionSettings() {
      const raw = await storage.get(VISION_SETTINGS_KEY);
      if (raw === null) return { imageLimit: 10, compactionModel: null };
      try {
        const obj = JSON.parse(raw) as { imageLimit?: number; compactionModel?: string | null };
        return {
          imageLimit: typeof obj.imageLimit === "number" ? obj.imageLimit : 10,
          compactionModel: obj.compactionModel ?? null,
        };
      } catch {
        return { imageLimit: 10, compactionModel: null };
      }
    },

    async setVisionImageLimit(limit) {
      const current = await this.getVisionSettings();
      const obj = { imageLimit: limit, compactionModel: current.compactionModel };
      await storage.set(VISION_SETTINGS_KEY, JSON.stringify(obj));
    },

    async setVisionCompactionModel(model) {
      const current = await this.getVisionSettings();
      const obj = { imageLimit: current.imageLimit, compactionModel: model };
      await storage.set(VISION_SETTINGS_KEY, JSON.stringify(obj));
    },

    async setCompactedFrom(conversationId, newConversationId) {
      const raw = await storage.get(metaKey(conversationId));
      const existing = raw !== null ? parseMetaRow(raw) : null;
      const ts = now();
      const row: ConversationMetaRow = existing ?? {
        createdAt: ts,
        lastActivityAt: ts,
        title: "Untitled",
        status: "idle",
      };
      await storage.set(
        metaKey(conversationId),
        JSON.stringify({ ...row, compactedFrom: newConversationId }),
      );
    },

    async getWorkspace(id) {
      const row = await readWorkspaceRow(id);
      if (row !== null) return toWorkspace(id, row);
      // Synthesize the always-present "default" workspace when it was
      // never persisted (title "default", defaultCwd null, defaultComputerId
      // null [local], starred false, timestamps 0).
      if (id === DEFAULT_WORKSPACE_ID) {
        return {
          id: DEFAULT_WORKSPACE_ID,
          title: DEFAULT_WORKSPACE_ID,
          defaultCwd: null,
          defaultComputerId: null,
          starred: false,
          createdAt: 0,
          lastActivityAt: 0,
        };
      }
      return null;
    },

    async ensureWorkspace(id, opts) {
      const existing = await readWorkspaceRow(id);
      if (existing !== null) return toWorkspace(id, existing);
      // Absent — create with defaults. The synthesized "default" is also
      // materialized here when first explicitly ensured.
      const ts = now();
      const row: WorkspaceRow = {
        title: opts?.title ?? id,
        defaultCwd: opts?.defaultCwd ?? null,
        defaultComputerId: opts?.defaultComputerId ?? null,
        starred: false,
        createdAt: ts,
        lastActivityAt: ts,
      };
      await storage.set(workspaceKey(id), JSON.stringify(row));
      return toWorkspace(id, row);
    },

    async setWorkspaceTitle(id, title) {
      const existing = await readWorkspaceRow(id);
      const ts = now();
      const base =
        existing === null
          ? {
              title: id,
              defaultCwd: null as string | null,
              defaultComputerId: null as string | null,
              starred: false as boolean,
              createdAt: ts,
              lastActivityAt: ts,
            }
          : existing;
      const row: WorkspaceRow = {
        title,
        defaultCwd: base.defaultCwd,
        defaultComputerId: base.defaultComputerId,
        starred: base.starred,
        createdAt: base.createdAt,
        lastActivityAt: base.lastActivityAt,
      };
      await storage.set(workspaceKey(id), JSON.stringify(row));
      return toWorkspace(id, row);
    },

    async setWorkspaceDefaultCwd(id, defaultCwd) {
      const existing = await readWorkspaceRow(id);
      const ts = now();
      const base =
        existing === null
          ? {
              title: id,
              defaultCwd: null as string | null,
              defaultComputerId: null as string | null,
              starred: false as boolean,
              createdAt: ts,
              lastActivityAt: ts,
            }
          : existing;
      const row: WorkspaceRow = {
        title: base.title,
        defaultCwd,
        defaultComputerId: base.defaultComputerId,
        starred: base.starred,
        createdAt: base.createdAt,
        lastActivityAt: base.lastActivityAt,
      };
      await storage.set(workspaceKey(id), JSON.stringify(row));
      return toWorkspace(id, row);
    },

    async setWorkspaceDefaultComputerId(id, defaultComputerId) {
      const existing = await readWorkspaceRow(id);
      const ts = now();
      const base =
        existing === null
          ? {
              title: id,
              defaultCwd: null as string | null,
              defaultComputerId: null as string | null,
              starred: false as boolean,
              createdAt: ts,
              lastActivityAt: ts,
            }
          : existing;
      const row: WorkspaceRow = {
        title: base.title,
        defaultCwd: base.defaultCwd,
        defaultComputerId,
        starred: base.starred,
        createdAt: base.createdAt,
        lastActivityAt: base.lastActivityAt,
      };
      await storage.set(workspaceKey(id), JSON.stringify(row));
      return toWorkspace(id, row);
    },

    async setWorkspaceStarred(id, starred) {
      const existing = await readWorkspaceRow(id);
      const ts = now();
      const base =
        existing === null
          ? {
              title: id,
              defaultCwd: null as string | null,
              defaultComputerId: null as string | null,
              createdAt: ts,
              lastActivityAt: ts,
            }
          : existing;
      const row: WorkspaceRow = {
        title: base.title,
        defaultCwd: base.defaultCwd,
        defaultComputerId: base.defaultComputerId,
        starred,
        createdAt: base.createdAt,
        lastActivityAt: base.lastActivityAt,
      };
      await storage.set(workspaceKey(id), JSON.stringify(row));
      if (logger !== undefined) {
        logger.debug("workspace starred set", { workspaceId: id, starred });
      }
      return toWorkspace(id, row);
    },

    async deleteWorkspace(id) {
      if (id === DEFAULT_WORKSPACE_ID) {
        throw new Error('The "default" workspace cannot be deleted.');
      }
      // (1) Find all conversations with workspaceId === id, (2) set each
      // to status "closed" and reassign workspaceId to "default".
      let closedCount = 0;
      const indexRaw = await storage.get(CONVERSATION_INDEX_KEY);
      if (indexRaw !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(indexRaw);
        } catch {
          parsed = [];
        }
        const ids = Array.isArray(parsed)
          ? (parsed.filter((v) => typeof v === "string") as string[])
          : [];
        for (const convId of ids) {
          const metaRaw = await storage.get(metaKey(convId));
          if (metaRaw === null) continue;
          const row = parseMetaRow(metaRaw);
          if (row === null) continue;
          const wsId = row.workspaceId ?? DEFAULT_WORKSPACE_ID;
          if (wsId !== id) continue;
          const updated: ConversationMetaRow = {
            createdAt: row.createdAt,
            lastActivityAt: row.lastActivityAt,
            title: row.title,
            status: "closed",
            ...(row.compactedFrom !== undefined ? { compactedFrom: row.compactedFrom } : {}),
            workspaceId: DEFAULT_WORKSPACE_ID,
          };
          await storage.set(metaKey(convId), JSON.stringify(updated));
          closedCount++;
        }
      }
      // (3) Delete the workspace entity.
      await storage.delete(workspaceKey(id));
      return { closedCount };
    },

    async listWorkspaces() {
      // Collect persisted workspace rows via the `workspace:` key prefix.
      const wsPrefix = "workspace:";
      const wsKeys = await storage.keys(wsPrefix);
      const byId = new Map<string, Workspace>();
      for (const key of wsKeys) {
        // Key shape: `workspace:<id>`. Strip the prefix to recover the id.
        const id = key.slice(wsPrefix.length);
        if (id.length === 0) continue;
        const raw = await storage.get(key);
        if (raw === null) continue;
        const row = parseWorkspaceRow(raw);
        if (row === null) continue;
        byId.set(id, toWorkspace(id, row));
      }
      // Always include "default" (synthesized if not persisted).
      if (!byId.has(DEFAULT_WORKSPACE_ID)) {
        byId.set(DEFAULT_WORKSPACE_ID, {
          id: DEFAULT_WORKSPACE_ID,
          title: DEFAULT_WORKSPACE_ID,
          defaultCwd: null,
          defaultComputerId: null,
          starred: false,
          createdAt: 0,
          lastActivityAt: 0,
        });
      }
      // Count conversations per workspace by scanning the index + meta.
      const counts = new Map<string, number>();
      for (const id of byId.keys()) counts.set(id, 0);
      const indexRaw = await storage.get(CONVERSATION_INDEX_KEY);
      if (indexRaw !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(indexRaw);
        } catch {
          parsed = [];
        }
        const ids = Array.isArray(parsed)
          ? (parsed.filter((v) => typeof v === "string") as string[])
          : [];
        for (const convId of ids) {
          const metaRaw = await storage.get(metaKey(convId));
          if (metaRaw === null) continue;
          const row = parseMetaRow(metaRaw);
          if (row === null) continue;
          const wsId = row.workspaceId ?? DEFAULT_WORKSPACE_ID;
          counts.set(wsId, (counts.get(wsId) ?? 0) + 1);
        }
      }
      const entries: WorkspaceEntry[] = [];
      for (const [id, ws] of byId) {
        entries.push({ ...ws, conversationCount: counts.get(id) ?? 0 });
      }
      // Sort by lastActivityAt descending (most recent first). Stable sort
      // keeps insertion order for ties.
      return entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    },

    async getWorkspaceId(conversationId) {
      const raw = await storage.get(metaKey(conversationId));
      if (raw === null) return DEFAULT_WORKSPACE_ID;
      const row = parseMetaRow(raw);
      if (row === null) return DEFAULT_WORKSPACE_ID;
      return row.workspaceId ?? DEFAULT_WORKSPACE_ID;
    },

    async setWorkspaceId(conversationId, workspaceId) {
      const ts = now();
      const raw = await storage.get(metaKey(conversationId));
      if (raw === null) {
        // Conversation doesn't exist yet — create a minimal metadata row
        // (like setConversationStatus does), with the workspace assigned.
        const row: ConversationMetaRow = {
          createdAt: ts,
          lastActivityAt: ts,
          title: "Untitled",
          status: "idle",
          workspaceId,
        };
        await storage.set(metaKey(conversationId), JSON.stringify(row));
        await ensureInIndex(conversationId);
        return;
      }
      const existing = parseMetaRow(raw);
      if (existing === null) {
        const row: ConversationMetaRow = {
          createdAt: ts,
          lastActivityAt: ts,
          title: "Untitled",
          status: "idle",
          workspaceId,
        };
        await storage.set(metaKey(conversationId), JSON.stringify(row));
        await ensureInIndex(conversationId);
        return;
      }
      const row: ConversationMetaRow = {
        createdAt: existing.createdAt,
        lastActivityAt: existing.lastActivityAt,
        title: existing.title,
        status: existing.status,
        ...(existing.compactedFrom !== undefined ? { compactedFrom: existing.compactedFrom } : {}),
        workspaceId,
      };
      await storage.set(metaKey(conversationId), JSON.stringify(row));
    },

    async getEffectiveCwd(conversationId, overrideCwd) {
      const workspaceId = await this.getWorkspaceId(conversationId);
      const workspace = await this.getWorkspace(workspaceId);
      const workspaceCwd = workspace?.defaultCwd ?? null;
      // When an explicit override is given, resolve IT instead of the
      // persisted cwd — it is always a string, never null.
      const conversationCwd =
        overrideCwd !== undefined ? overrideCwd : await this.getCwd(conversationId);

      if (conversationCwd === null) {
        return workspaceCwd ?? serverDefaultCwd;
      }
      if (conversationCwd.startsWith("/")) {
        return conversationCwd;
      }
      return pathResolve(workspaceCwd ?? serverDefaultCwd, conversationCwd);
    },

    async getEffectiveComputer(conversationId, overrideAlias) {
      const workspaceId = await this.getWorkspaceId(conversationId);
      const workspace = await this.getWorkspace(workspaceId);
      const workspaceComputerId = workspace?.defaultComputerId ?? null;
      // When an explicit override is given, it wins outright — even `null`
      // (explicitly local for this turn) does NOT fall through to the
      // persisted / workspace values.
      if (overrideAlias !== undefined) {
        return overrideAlias;
      }
      // Persisted per-conversation computerId → workspace defaultComputerId → null (LOCAL).
      const computerId = await this.getComputerId(conversationId);
      return computerId ?? workspaceComputerId;
    },
  };
}
