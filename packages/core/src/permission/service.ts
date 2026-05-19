import { evaluate } from "./evaluate.js";
import type { PermissionReply, PermissionRequest, PermissionRule, Ruleset } from "./index.js";

export class PermissionService {
	private pending: Map<
		string,
		{
			request: PermissionRequest;
			resolve: (reply: PermissionReply) => void;
			reject: (err: Error) => void;
		}
	> = new Map();
	private approved: Ruleset = [];
	private idCounter = 0;

	approve(rules: PermissionRule[]): void {
		this.approved.push(...rules);
	}

	async ask(request: PermissionRequest, rulesets: Ruleset[]): Promise<PermissionReply> {
		// Evaluate against all rulesets + approved (approved overrides) for ALL patterns
		const patterns = request.always.length > 0 ? request.always : ["*"];
		const results = patterns.map((pattern) =>
			evaluate(request.permission, pattern, ...rulesets, this.approved),
		);

		// Any deny → deny
		const denied = results.find((r) => r.action === "deny");
		if (denied) {
			throw new Error(`Permission denied: ${request.permission} ${denied.pattern}`);
		}

		// All allow → allow
		if (results.every((r) => r.action === "allow")) {
			return "once";
		}

		// action === "ask" — create a pending request
		const id = String(++this.idCounter);
		return new Promise<PermissionReply>((resolve, reject) => {
			this.pending.set(id, { request, resolve, reject });
		});
	}

	reply(id: string, reply: PermissionReply): void {
		if (reply === "reject") {
			// Reject cascade — reject all pending
			for (const [pendingId, entry] of this.pending) {
				entry.reject(new Error(`Permission rejected: ${entry.request.permission}`));
				this.pending.delete(pendingId);
			}
			return;
		}

		this.resolvePending(id, reply);
	}

	getPending(): Array<{ id: string; request: PermissionRequest }> {
		return Array.from(this.pending.entries()).map(([id, { request }]) => ({ id, request }));
	}

	private resolvePending(id: string, reply: PermissionReply): void {
		const entry = this.pending.get(id);
		if (!entry) return;

		if (reply === "always") {
			// Add rules for each pattern in request.patterns
			for (const pattern of entry.request.patterns) {
				this.approved.push({ permission: entry.request.permission, pattern, action: "allow" });
			}
		}

		entry.resolve(reply);
		this.pending.delete(id);
	}
}
