import type { ChatMessage, StorageNamespace } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import { msgKey, msgPrefix, parseSeq, seqKey } from "./keys.js";
import { reconcile } from "./reconcile.js";

export interface ConversationStore {
	readonly append: (conversationId: string, messages: readonly ChatMessage[]) => Promise<void>;
	readonly load: (conversationId: string) => Promise<ChatMessage[]>;
}

export const conversationStoreHandle = defineService<ConversationStore>("conversation-store/store");

export function createConversationStore(storage: StorageNamespace): ConversationStore {
	return {
		async append(conversationId, messages) {
			const raw = await storage.get(seqKey(conversationId));
			let seq = parseSeq(raw);

			for (const msg of messages) {
				await storage.set(msgKey(conversationId, seq), JSON.stringify(msg));
				seq++;
			}

			await storage.set(seqKey(conversationId), String(seq));
		},

		async load(conversationId) {
			const prefix = msgPrefix(conversationId);
			const keys = await storage.keys(prefix);
			const sorted = [...keys].sort();

			const raw: ChatMessage[] = [];
			for (const key of sorted) {
				const value = await storage.get(key);
				if (value !== null) {
					raw.push(JSON.parse(value) as ChatMessage);
				}
			}

			return reconcile(raw);
		},
	};
}
