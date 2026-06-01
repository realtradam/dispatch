import {
	type PermissionReply,
	type PermissionRequest,
	PermissionService,
	type Ruleset,
} from "@dispatch/core";

/**
 * Listener fired exactly once per newly-created pending prompt. Used by
 * the notification dispatcher so that a permission request triggers a
 * push notification on the user's phone (without re-firing every time
 * the pending list mutates for an unrelated reason).
 */
export type PromptAddedListener = (prompt: {
	id: string;
	permission: string;
	description: string;
	metadata: Record<string, unknown>;
}) => void;

export class PermissionManager {
	private service = new PermissionService();
	private wsClients: Map<string, (data: unknown) => void> = new Map();
	private promptAddedListeners: Set<PromptAddedListener> = new Set();
	/** Ids that have already been broadcast as "added" — guards against re-emits. */
	private announcedPromptIds: Set<string> = new Set();

	registerClient(id: string, send: (data: unknown) => void): void {
		this.wsClients.set(id, send);
	}

	unregisterClient(id: string): void {
		this.wsClients.delete(id);
	}

	private broadcastPending(pending: Array<{ id: string; request: PermissionRequest }>): void {
		const message = {
			type: "permission-prompt",
			pending: pending.map((p) => ({ id: p.id, ...p.request })),
		};
		for (const send of this.wsClients.values()) {
			send(message);
		}

		// Detect newly-added prompts (ids present now that weren't before) and
		// fire `promptAddedListeners` once for each. Resolved/rejected ids are
		// pruned from `announcedPromptIds` so a future prompt that reuses an
		// id (theoretical, given the monotonic counter) would still notify.
		const currentIds = new Set(pending.map((p) => p.id));
		for (const id of this.announcedPromptIds) {
			if (!currentIds.has(id)) this.announcedPromptIds.delete(id);
		}
		for (const p of pending) {
			if (this.announcedPromptIds.has(p.id)) continue;
			this.announcedPromptIds.add(p.id);
			for (const listener of this.promptAddedListeners) {
				try {
					listener({
						id: p.id,
						permission: p.request.permission,
						description: p.request.description,
						metadata: p.request.metadata,
					});
				} catch (err) {
					console.warn(
						`[permission] promptAdded listener threw: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}

	async ask(request: PermissionRequest, rulesets: Ruleset[] = []): Promise<PermissionReply> {
		const promise = this.service.ask(request, rulesets);
		this.broadcastPending(this.service.getPending());
		return promise;
	}

	reply(id: string, reply: PermissionReply): void {
		this.service.reply(id, reply);
		this.broadcastPending(this.service.getPending());
	}

	getPending(): Array<{ id: string; request: PermissionRequest }> {
		return this.service.getPending();
	}

	getService(): PermissionService {
		return this.service;
	}

	/**
	 * Subscribe to "a new prompt is now pending" events. Fires once per
	 * unique prompt id, even if `broadcastPending` is called repeatedly
	 * for unrelated mutations. Returns an unsubscribe function.
	 */
	onPromptAdded(listener: PromptAddedListener): () => void {
		this.promptAddedListeners.add(listener);
		return () => {
			this.promptAddedListeners.delete(listener);
		};
	}
}
