import { describe, expect, it } from "vitest";
import type { PermissionRequest, Ruleset } from "../../src/permission/index.js";
import { PermissionService } from "../../src/permission/service.js";

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
	return {
		permission: "bash",
		patterns: ["git *"],
		always: ["git status"],
		description: "Run git status",
		metadata: {},
		...overrides,
	};
}

describe("PermissionService", () => {
	it("resolves immediately with 'once' when rule is allow", async () => {
		const svc = new PermissionService();
		const rules: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
		const reply = await svc.ask(makeRequest(), [rules]);
		expect(reply).toBe("once");
	});

	it("rejects immediately when rule is deny", async () => {
		const svc = new PermissionService();
		const rules: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];
		await expect(svc.ask(makeRequest(), [rules])).rejects.toThrow("Permission denied");
	});

	it("creates pending request when rule is ask", () => {
		const svc = new PermissionService();
		svc.ask(makeRequest(), []);
		expect(svc.getPending()).toHaveLength(1);
	});

	it("reply 'once' resolves the specific pending request", async () => {
		const svc = new PermissionService();
		const promise = svc.ask(makeRequest(), []);
		const pending = svc.getPending();
		expect(pending).toHaveLength(1);
		svc.reply(pending[0].id, "once");
		const result = await promise;
		expect(result).toBe("once");
		expect(svc.getPending()).toHaveLength(0);
	});

	it("reply 'always' adds approved rules and resolves", async () => {
		const svc = new PermissionService();
		const promise = svc.ask(makeRequest({ patterns: ["git *"] }), []);
		const pending = svc.getPending();
		svc.reply(pending[0].id, "always");
		const result = await promise;
		expect(result).toBe("always");

		// Now the same permission should be immediately allowed
		const reply2 = await svc.ask(makeRequest({ always: ["git commit"] }), []);
		expect(reply2).toBe("once");
	});

	it("reply 'reject' rejects all pending requests (cascade)", async () => {
		const svc = new PermissionService();
		const p1 = svc.ask(makeRequest(), []);
		const p2 = svc.ask(makeRequest({ permission: "read" }), []);

		const pending = svc.getPending();
		expect(pending).toHaveLength(2);

		// Reject using the first id — should cascade to all
		svc.reply(pending[0].id, "reject");

		await expect(p1).rejects.toThrow("Permission rejected");
		await expect(p2).rejects.toThrow("Permission rejected");
		expect(svc.getPending()).toHaveLength(0);
	});

	it("approved rules override config rulesets", async () => {
		const svc = new PermissionService();
		svc.approve([{ permission: "bash", pattern: "git *", action: "allow" }]);

		// Config says deny, but approved says allow — approved wins (last)
		const configRules: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];
		const reply = await svc.ask(makeRequest({ always: ["git status"] }), [configRules]);
		expect(reply).toBe("once");
	});

	it("getPending returns all pending requests with id and request", () => {
		const svc = new PermissionService();
		const req = makeRequest();
		svc.ask(req, []);
		const pending = svc.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0].id).toBeDefined();
		expect(pending[0].request.permission).toBe("bash");
	});
});
