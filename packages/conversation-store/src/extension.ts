import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { conversationStoreHandle, createConversationStore } from "./store.js";

export const manifest: Manifest = {
	id: "conversation-store",
	name: "Conversation Store",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	capabilities: { db: true },
	contributes: { services: ["conversation-store/store"] },
	activation: "eager",
};

export const extension: Extension = {
	manifest,
	activate: async (host: HostAPI) => {
		const storage = host.storage("conversation-store");
		const store = createConversationStore(storage, host.logger, undefined, process.cwd());

		const stale = await store.listConversations({ status: ["active"] });
		for (const m of stale) {
			await store.setConversationStatus(m.id, "idle");
		}
		if (stale.length > 0) {
			host.logger.info("conversation-store: boot-sweep", { resetCount: stale.length });
		}

		host.provideService(conversationStoreHandle, store);
	},
};
