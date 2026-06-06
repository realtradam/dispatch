import type { ChatMessage, Chunk, Role, StorageNamespace, StoredChunk } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import { chunkKey, chunkPrefix, parseSeq, seqKey } from "./keys.js";
import { reconcile } from "./reconcile.js";

export interface ConversationStore {
	readonly append: (conversationId: string, messages: readonly ChatMessage[]) => Promise<void>;
	readonly load: (conversationId: string) => Promise<ChatMessage[]>;
	readonly loadSince: (
		conversationId: string,
		sinceSeq?: number,
	) => Promise<readonly StoredChunk[]>;
}

export const conversationStoreHandle = defineService<ConversationStore>("conversation-store/store");

interface PersistedChunkEntry {
	readonly chunk: Chunk;
	readonly role: Role;
	readonly msgIdx: number;
	readonly chunkIdx: number;
}

export function createConversationStore(storage: StorageNamespace): ConversationStore {
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

			return reconcile(messages);
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
	};
}
