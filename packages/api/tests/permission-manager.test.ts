import { describe, expect, it, vi } from "vitest";

// Mock @dispatch/core to provide only the PermissionService impl this test
// touches — the core barrel transitively pulls in bun:sqlite, which vitest
// running under Node cannot resolve.
vi.mock("@dispatch/core", async () => {
	const mod = await import("../../core/src/permission/service.js");
	return {
		PermissionService: mod.PermissionService,
	};
});

const { PermissionManager } = await import("../src/permission-manager.js");

interface PermissionRequest {
	permission: string;
	patterns: string[];
	always: string[];
	description: string;
	metadata: Record<string, unknown>;
}

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

describe("PermissionManager.onPromptAdded", () => {
	it("fires once per newly-added pending prompt", () => {
		const mgr = new PermissionManager();
		const seen: Array<{ id: string; permission: string }> = [];
		mgr.onPromptAdded((p) => {
			seen.push({ id: p.id, permission: p.permission });
		});

		void mgr.ask(makeRequest(), []);
		void mgr.ask(makeRequest({ permission: "read", description: "Read X" }), []);

		expect(seen).toHaveLength(2);
		expect(seen[0].permission).toBe("bash");
		expect(seen[1].permission).toBe("read");
		// Distinct ids
		expect(seen[0].id).not.toBe(seen[1].id);
	});

	it("does not re-fire when the pending list is rebroadcast for an unrelated change", async () => {
		const mgr = new PermissionManager();
		const seen: string[] = [];
		mgr.onPromptAdded((p) => seen.push(p.id));

		// Two prompts in; should see two notifications.
		const p1 = mgr.ask(makeRequest(), []);
		void mgr.ask(makeRequest({ permission: "read" }), []);
		expect(seen).toHaveLength(2);

		// Resolve the first one — broadcastPending fires again, but the
		// remaining (already-announced) prompt must NOT re-notify.
		const pending = mgr.getPending();
		const firstId = pending[0].id;
		mgr.reply(firstId, "once");
		await p1;

		expect(seen).toHaveLength(2);
	});

	it("unsubscribe stops further notifications", () => {
		const mgr = new PermissionManager();
		const seen: string[] = [];
		const unsub = mgr.onPromptAdded((p) => seen.push(p.id));
		void mgr.ask(makeRequest(), []);
		unsub();
		void mgr.ask(makeRequest({ permission: "read" }), []);
		expect(seen).toHaveLength(1);
	});

	it("listener throws are caught and don't break other listeners", () => {
		const mgr = new PermissionManager();
		const seen: string[] = [];
		mgr.onPromptAdded(() => {
			throw new Error("boom");
		});
		mgr.onPromptAdded((p) => seen.push(p.id));
		// Swallow the warn during this test.
		const origWarn = console.warn;
		console.warn = () => {};
		try {
			void mgr.ask(makeRequest(), []);
		} finally {
			console.warn = origWarn;
		}
		expect(seen).toHaveLength(1);
	});
});
