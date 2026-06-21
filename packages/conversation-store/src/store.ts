import type {
	ChatMessage,
	Chunk,
	ConversationMeta,
	Logger,
	ReasoningEffort,
	Role,
	StorageNamespace,
	StoredChunk,
	TurnMetrics,
} from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import {
	CONVERSATION_INDEX_KEY,
	chunkKey,
	chunkPrefix,
	cwdKey,
	metaKey,
	metricsKey,
	metricsPrefix,
	metricsSeqKey,
	parseSeq,
	reasoningEffortKey,
	seqKey,
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
	/** The persisted reasoning-effort level for a conversation, or null if never set. */
	readonly getReasoningEffort: (conversationId: string) => Promise<ReasoningEffort | null>;
	/** Persist (upsert) the reasoning-effort level for a conversation. */
	readonly setReasoningEffort: (conversationId: string, effort: ReasoningEffort) => Promise<void>;
	/**
	 * List all known conversations, sorted by `lastActivityAt` descending (most
	 * recent first). Metadata (createdAt, lastActivityAt, title) is tracked
	 * automatically on append; title defaults to the first user message.
	 */
	readonly listConversations: () => Promise<readonly ConversationMeta[]>;
	/** Single conversation metadata, or null if unknown. */
	readonly getConversationMeta: (conversationId: string) => Promise<ConversationMeta | null>;
	/** Set/update the human-readable title for a conversation. */
	readonly setConversationTitle: (conversationId: string, title: string) => Promise<void>;
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
	return parsed as ConversationMetaRow;
}

function toMeta(id: string, row: ConversationMetaRow): ConversationMeta {
	return {
		id,
		createdAt: row.createdAt,
		lastActivityAt: row.lastActivityAt,
		title: row.title,
	};
}

export function createConversationStore(
	storage: StorageNamespace,
	logger?: Logger,
	now: () => number = Date.now,
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
			const metaRaw = await storage.get(metaKey(conversationId));
			if (metaRaw === null) {
				const row: ConversationMetaRow = {
					createdAt: ts,
					lastActivityAt: ts,
					title: extractTitle(messages),
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
					};
					await storage.set(metaKey(conversationId), JSON.stringify(row));
					await ensureInIndex(conversationId);
				} else {
					const title =
						existing.title === "Untitled" || existing.title === ""
							? extractTitle(messages)
							: existing.title;
					const row: ConversationMetaRow = {
						createdAt: existing.createdAt,
						lastActivityAt: ts,
						title,
					};
					await storage.set(metaKey(conversationId), JSON.stringify(row));
				}
			}
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
				const entry = JSON.parse(value) as PersistedChunkEntry;

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

			if (report.repairedCount > 0 && logger !== undefined) {
				const child = logger.child({ conversationId });
				const span = child.span("reconcile.repair", {
					repairedCount: report.repairedCount,
					firstRepairedToolCallId: report.repairedToolCallIds[0] ?? null,
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

		async getReasoningEffort(conversationId) {
			return (await storage.get(reasoningEffortKey(conversationId))) as ReasoningEffort | null;
		},

		async setReasoningEffort(conversationId, effort) {
			await storage.set(reasoningEffortKey(conversationId), effort);
			if (logger !== undefined) {
				logger.debug("reasoning-effort set", { conversationId });
			}
		},
		async listConversations() {
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

			const metas: ConversationMeta[] = [];
			for (const id of ids) {
				const metaRaw = await storage.get(metaKey(id));
				if (metaRaw === null) continue;
				const row = parseMetaRow(metaRaw);
				if (row === null) continue;
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
				};
				await storage.set(metaKey(conversationId), JSON.stringify(row));
				await ensureInIndex(conversationId);
				return;
			}
			// Preserve createdAt + lastActivityAt; update only the title.
			const row: ConversationMetaRow = {
				createdAt: existing.createdAt,
				lastActivityAt: existing.lastActivityAt,
				title,
			};
			await storage.set(metaKey(conversationId), JSON.stringify(row));
		},
	};
}
