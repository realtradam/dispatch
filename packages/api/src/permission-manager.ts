import {
	PermissionService,
	type PermissionReply,
	type PermissionRequest,
	type Ruleset,
} from "@dispatch/core";

export class PermissionManager {
	private service = new PermissionService();
	private wsClients: Map<string, (data: unknown) => void> = new Map();

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
}
