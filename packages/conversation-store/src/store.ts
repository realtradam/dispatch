import type {
	ChatMessage,
	Chunk,
	Logger,
	Role,
	StorageNamespace,
	StoredChunk,
	TurnMetrics,
} from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import {
	chunkKey,
	chunkPrefix,
	metricsKey,
	metricsPrefix,
	metricsSeqKey,
	parseSeq,
	seqKey,
} from "./keys.js";
import { reconcileWithReport } from "./reconcile.js";

export interface ConversationStore {
	readonly append: (conversationId: string, messages: readonly ChatMessage[]) => Promise<void>;
	readonly load: (conversationId: string) => Promise<ChatMessage[]>;
	readonly loadSince: (
		conversationId: string,
		sinceSeq?: number,
	) => Promise<readonly StoredChunk[]>;
	readonly appendMetrics: (conversationId: string, metrics: TurnMetrics) => Promise<void>;
	readonly loadMetrics: (conversationId: string) => Promise<readonly TurnMetrics[]>;
}

export const conversationStoreHandle = defineService<ConversationStore>("conversation-store/store");

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

		async loadSince(conversationId, sinceSeq) {
			const prefix = chunkPrefix(conversationId);
			const keys = await storage.keys(prefix);
			const sorted = [...keys].sort();

			const result: StoredChunk[] = [];
			const minSeq = sinceSeq ?? 0;

			for (const key of sorted) {
				const seq = parseSeq(key.split(":").pop() ?? null);
				if (seq <= minSeq) continue;
				const value = await storage.get(key);
				if (value === null) continue;
				const entry = JSON.parse(value) as PersistedChunkEntry;
				result.push({ seq, role: entry.role, chunk: entry.chunk });
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
	};
}
