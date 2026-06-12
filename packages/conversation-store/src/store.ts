import type {
	ChatMessage,
	Chunk,
	Logger,
	ReasoningEffort,
	Role,
	StorageNamespace,
	StoredChunk,
	TurnMetrics,
} from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import {
	chunkKey,
	chunkPrefix,
	cwdKey,
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

interface PersistedChunkEntry {
	readonly chunk: Chunk;
	readonly role: Role;
	readonly msgIdx: number;
	readonly chunkIdx: number;
}

export function createConversationStore(
	storage: StorageNamespace,
	logger?: Logger,
): ConversationStore {
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
			const minSeq = sinceSeq ?? 0;
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
	};
}
