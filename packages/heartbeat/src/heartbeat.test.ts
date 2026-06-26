import type { StorageNamespace } from "@dispatch/kernel";
import type {
	EnqueueInput,
	EnqueueResult,
	SessionOrchestrator,
	StartTurnResult,
	TurnEventListener,
} from "@dispatch/session-orchestrator";
import { describe, expect, it } from "vitest";
import { createHeartbeatService } from "./heartbeat.js";

function createMemoryStorage(): StorageNamespace {
	const data = new Map<string, string>();
	return {
		get: async (key) => data.get(key) ?? null,
		set: async (key, value) => {
			data.set(key, value);
		},
		delete: async (key) => {
			data.delete(key);
		},
		has: async (key) => data.has(key),
		keys: async (prefix) => {
			const all = [...data.keys()];
			if (prefix === undefined) return all;
			return all.filter((k) => k.startsWith(prefix));
		},
	};
}

/** A controllable fake clock with an `advance` to move virtual time. */
function createFakeTimers() {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { readonly fn: () => void; readonly firesAt: number }>();
	return {
		timers: {
			now: () => now,
			setTimeout: (fn: () => void, ms: number) => {
				const id = nextId++;
				timers.set(id, { fn, firesAt: now + ms });
				return id as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeout: (handle: ReturnType<typeof setTimeout> | undefined) => {
				if (handle !== undefined) timers.delete(handle as unknown as number);
			},
		},
		advance(ms: number): void {
			now += ms;
			const due = [...timers.entries()]
				.filter(([, t]) => t.firesAt <= now)
				.sort((a, b) => a[0] - b[0]);
			for (const [id, t] of due) {
				timers.delete(id);
				t.fn();
			}
		},
	};
}

interface PendingTurn {
	readonly conversationId: string;
	readonly text: string;
	readonly systemPrompt?: string;
	readonly modelName?: string;
	readonly reasoningEffort?: unknown;
	readonly workspaceId?: string;
	resolve: () => void;
}

/**
 * A fake orchestrator that records handleMessage calls and lets the test
 * control when each turn seals. This is the injected edge — the service depends
 * on the SessionOrchestrator interface, not its implementation.
 */
function createFakeOrchestrator(): SessionOrchestrator & {
	readonly pending: readonly PendingTurn[];
	readonly stopped: readonly string[];
} {
	const pending: PendingTurn[] = [];
	const stopped: string[] = [];
	const turns = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();

	const fake: SessionOrchestrator = {
		startTurn(): StartTurnResult {
			return { started: false, reason: "already-active" };
		},
		enqueue(_input: EnqueueInput): EnqueueResult {
			return { startedTurn: false, queue: [] };
		},
		subscribe(_conversationId: string, _listener: TurnEventListener): () => void {
			return () => {};
		},
		isActive(_conversationId: string): boolean {
			return false;
		},
		closeConversation(_conversationId: string): { abortedTurn: boolean } {
			return { abortedTurn: false };
		},
		stopTurn(conversationId: string): { abortedTurn: boolean } {
			stopped.push(conversationId);
			const t = turns.get(conversationId);
			if (t !== undefined) {
				turns.delete(conversationId);
				t.resolve();
			}
			return { abortedTurn: true };
		},
		handleMessage(input): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				const entry: PendingTurn = {
					conversationId: input.conversationId,
					text: input.text,
					...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
					...(input.modelName !== undefined ? { modelName: input.modelName } : {}),
					...(input.reasoningEffort !== undefined
						? { reasoningEffort: input.reasoningEffort }
						: {}),
					...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
					resolve,
				};
				pending.push(entry);
				turns.set(input.conversationId, { resolve, reject });
			});
		},
	};
	return Object.assign(fake, {
		get pending(): readonly PendingTurn[] {
			return pending;
		},
		get stopped(): readonly string[] {
			return stopped;
		},
	});
}

// Drain microtasks so async .finally handlers (run completion) run. `fire` has
// nested awaits (configStore.get → storage.get, runStore.create → storage.set)
// before it reaches handleMessage, so a single queueMicrotask isn't enough —
// setTimeout(0) schedules a macrotask, letting ALL pending microtasks drain.
const flush = async (): Promise<void> => {
	await new Promise((r) => setTimeout(r, 0));
};

function createService(opts: {
	readonly orch: ReturnType<typeof createFakeOrchestrator>;
	readonly storage?: StorageNamespace;
	readonly resolvePrompt?: (
		template: string,
		ctx: {
			readonly workspaceId: string;
			readonly conversationId: string;
			readonly model: string;
		},
	) => Promise<string>;
	readonly getGlobalSystemPrompt?: () => Promise<string>;
}) {
	const fake = createFakeTimers();
	let id = 0;
	const storage = opts.storage ?? createMemoryStorage();
	const svc = createHeartbeatService({
		storage,
		orchestrator: opts.orch,
		timers: fake.timers,
		generateId: () => `id-${++id}`,
		...(opts.resolvePrompt !== undefined ? { resolvePrompt: opts.resolvePrompt } : {}),
		...(opts.getGlobalSystemPrompt !== undefined
			? { getGlobalSystemPrompt: opts.getGlobalSystemPrompt }
			: {}),
	});
	return { svc, advance: fake.advance, storage };
}

describe("createHeartbeatService", () => {
	it("returns the default config for an unknown workspace", async () => {
		const { svc } = createService({ orch: createFakeOrchestrator() });
		const cfg = await svc.getConfig("ws-1");
		expect(cfg.enabled).toBe(false);
		expect(cfg.intervalMinutes).toBe(30);
	});

	it("arming an enabled config does not fire immediately (waits for the interval)", () => {
		const orch = createFakeOrchestrator();
		const { svc, advance } = createService({ orch });
		void svc.updateConfig("ws-1", { enabled: true, taskPrompt: "go" });
		// Just arming → no turn yet.
		expect(orch.pending).toHaveLength(0);
		// Advancing just shy of the interval still no fire.
		advance(59_999);
		expect(orch.pending).toHaveLength(0);
	});

	it("fire sends the task prompt with the explicit system prompt + model + effort, and marks completed on seal", async () => {
		const orch = createFakeOrchestrator();
		const { svc, advance } = createService({ orch });
		await svc.updateConfig("ws-1", {
			enabled: true,
			systemPrompt: "you are a monitor",
			taskPrompt: "check stuck chats",
			model: "opencode/gpt-4o",
			reasoningEffort: "high",
			intervalMinutes: 1,
		});

		advance(60_000); // 1-minute interval → fire
		await flush(); // let the async fire() reach handleMessage
		expect(orch.pending).toHaveLength(1);
		const turn = orch.pending[0]!;
		expect(turn.text).toBe("check stuck chats");
		expect(turn.systemPrompt).toBe("you are a monitor");
		expect(turn.modelName).toBe("opencode/gpt-4o");
		expect(turn.reasoningEffort).toBe("high");
		expect(turn.workspaceId).toBe("ws-1");

		expect((await svc.listRuns("ws-1"))[0]?.status).toBe("running");

		turn.resolve();
		await flush();
		expect((await svc.listRuns("ws-1"))[0]?.status).toBe("completed");
	});

	it("omits modelName/reasoningEffort when empty/null (inherit defaults)", async () => {
		const orch = createFakeOrchestrator();
		const { svc, advance } = createService({ orch });
		await svc.updateConfig("ws-1", {
			enabled: true,
			taskPrompt: "go",
			model: "",
			reasoningEffort: null,
			intervalMinutes: 1,
		});
		advance(60_000);
		await flush();
		const turn = orch.pending[0]!;
		expect(turn.modelName).toBeUndefined();
		expect(turn.reasoningEffort).toBeUndefined();
		turn.resolve();
		await flush();
	});

	it("resolves [type:name] variables in both systemPrompt and taskPrompt before sending", async () => {
		const orch = createFakeOrchestrator();
		// A fake resolver that mirrors the real resolver's contract: substitute
		// known [type:name] placeholders, leave unknown text verbatim.
		const resolvePrompt = async (
			template: string,
			ctx: {
				readonly workspaceId: string;
				readonly conversationId: string;
				readonly model: string;
			},
		): Promise<string> => {
			return template
				.replaceAll("[system:os]", "Linux (WSL)")
				.replaceAll("[prompt:cwd]", "/repo")
				.replaceAll("[prompt:workspace_id]", ctx.workspaceId)
				.replaceAll("[prompt:conversation_id]", ctx.conversationId)
				.replaceAll("[prompt:model]", ctx.model);
		};
		const { svc, advance } = createService({ orch, resolvePrompt });
		await svc.updateConfig("ws-1", {
			enabled: true,
			systemPrompt: "You run on [system:os] in [prompt:cwd] (ws [prompt:workspace_id]).",
			taskPrompt: "Check chats for [prompt:conversation_id] on [system:os].",
			model: "opencode/gpt-4o",
			intervalMinutes: 1,
		});

		advance(60_000);
		await flush();
		expect(orch.pending).toHaveLength(1);
		const turn = orch.pending[0]!;
		// Variables substituted — NOT left as literal [type:name] text.
		expect(turn.systemPrompt).toBe("You run on Linux (WSL) in /repo (ws ws-1).");
		expect(turn.text).toBe(`Check chats for ${turn.conversationId} on Linux (WSL).`);
		expect(turn.modelName).toBe("opencode/gpt-4o");
		turn.resolve();
		await flush();
	});

	it("passes prompts through raw when no resolver is wired (resolution is optional)", async () => {
		const orch = createFakeOrchestrator();
		// No resolvePrompt → raw pass-through (the default).
		const { svc, advance } = createService({ orch });
		await svc.updateConfig("ws-1", {
			enabled: true,
			systemPrompt: "raw [system:os] prompt",
			taskPrompt: "raw [system:date] task",
			intervalMinutes: 1,
		});

		advance(60_000);
		await flush();
		const turn = orch.pending[0]!;
		// Unresolved — literals reach the orchestrator verbatim.
		expect(turn.systemPrompt).toBe("raw [system:os] prompt");
		expect(turn.text).toBe("raw [system:date] task");
		turn.resolve();
		await flush();
	});

	it("an empty systemPrompt inherits the global system prompt template (CR-HB-2)", async () => {
		const orch = createFakeOrchestrator();
		// The global getter returns the workspace's regular system prompt
		// template (the same one GET /system-prompt returns). No resolver → the
		// inherited template reaches the orchestrator verbatim (isolates CR-HB-2
		// from CR-HB-1).
		const { svc, advance } = createService({
			orch,
			getGlobalSystemPrompt: () => Promise.resolve("GLOBAL DEFAULT TEMPLATE"),
		});
		await svc.updateConfig("ws-1", {
			enabled: true,
			// Empty systemPrompt = inherit the global default, NOT "no prompt".
			systemPrompt: "",
			taskPrompt: "go",
			intervalMinutes: 1,
		});

		advance(60_000);
		await flush();
		expect(orch.pending).toHaveLength(1);
		const turn = orch.pending[0]!;
		expect(turn.systemPrompt).toBe("GLOBAL DEFAULT TEMPLATE");
		turn.resolve();
		await flush();
	});

	it("CR-HB-2 composes with CR-HB-1: the inherited global template's [type:name] placeholders are resolved", async () => {
		const orch = createFakeOrchestrator();
		const resolvePrompt = async (
			template: string,
			ctx: {
				readonly workspaceId: string;
				readonly conversationId: string;
				readonly model: string;
			},
		): Promise<string> => {
			return template
				.replaceAll("[system:os]", "Linux (WSL)")
				.replaceAll("[prompt:cwd]", "/repo")
				.replaceAll("[prompt:workspace_id]", ctx.workspaceId);
		};
		// The global template carries [type:name] placeholders (like the real
		// default template embeds [prompt:cwd] / [file:AGENTS.md]).
		const { svc, advance } = createService({
			orch,
			resolvePrompt,
			getGlobalSystemPrompt: () =>
				Promise.resolve("You run on [system:os] in [prompt:cwd] (ws [prompt:workspace_id])."),
		});
		await svc.updateConfig("ws-1", {
			enabled: true,
			// Empty → inherit the global template, THEN resolve its placeholders.
			systemPrompt: "",
			taskPrompt: "go",
			intervalMinutes: 1,
		});

		advance(60_000);
		await flush();
		expect(orch.pending).toHaveLength(1);
		const turn = orch.pending[0]!;
		// The global template was inherited (not empty), then its [type:name]
		// placeholders were substituted — NOT left literal, NOT empty.
		expect(turn.systemPrompt).toBe("You run on Linux (WSL) in /repo (ws ws-1).");
		turn.resolve();
		await flush();
	});

	it("a non-empty systemPrompt override bypasses the global template (only CR-HB-1 applies)", async () => {
		const orch = createFakeOrchestrator();
		const resolvePrompt = async (template: string): Promise<string> =>
			template.replaceAll("[system:os]", "Linux (WSL)");
		const { svc, advance } = createService({
			orch,
			resolvePrompt,
			// A DISTINCT global template — must NOT be used when overriding.
			getGlobalSystemPrompt: () => Promise.resolve("GLOBAL SHOULD NOT APPEAR [system:os]"),
		});
		await svc.updateConfig("ws-1", {
			enabled: true,
			systemPrompt: "custom override on [system:os]",
			taskPrompt: "go",
			intervalMinutes: 1,
		});

		advance(60_000);
		await flush();
		const turn = orch.pending[0]!;
		// The override is used (and resolved), not the global template.
		expect(turn.systemPrompt).toBe("custom override on Linux (WSL)");
		turn.resolve();
		await flush();
	});

	it("an empty systemPrompt stays empty when no global getter is wired (resolution is optional)", async () => {
		const orch = createFakeOrchestrator();
		// No getGlobalSystemPrompt → empty stays empty (no system prompt).
		// Mirrors the no-resolver pass-through default: both deps are optional.
		const { svc, advance } = createService({ orch });
		await svc.updateConfig("ws-1", {
			enabled: true,
			systemPrompt: "",
			taskPrompt: "go",
			intervalMinutes: 1,
		});

		advance(60_000);
		await flush();
		const turn = orch.pending[0]!;
		expect(turn.systemPrompt).toBe("");
		turn.resolve();
		await flush();
	});

	it("stopRun aborts the turn and marks the run stopped (not overwritten on completion)", async () => {
		const orch = createFakeOrchestrator();
		const { svc, advance } = createService({ orch });
		await svc.updateConfig("ws-1", { enabled: true, taskPrompt: "go", intervalMinutes: 1 });
		advance(60_000);
		await flush();
		const conversationId = orch.pending[0]?.conversationId;
		const runId = (await svc.listRuns("ws-1"))[0]?.id;

		const res = await svc.stopRun("ws-1", runId);
		expect(res).toEqual({ ok: true });
		expect(orch.stopped).toEqual([conversationId]);

		await flush(); // the aborted turn's handleMessage resolves
		expect((await svc.listRuns("ws-1"))[0]?.status).toBe("stopped");
	});

	it("stopRun is idempotent for an already-finished run", async () => {
		const orch = createFakeOrchestrator();
		const { svc, advance } = createService({ orch });
		await svc.updateConfig("ws-1", { enabled: true, taskPrompt: "go", intervalMinutes: 1 });
		advance(60_000);
		await flush();
		orch.pending[0]?.resolve();
		await flush();

		const runId = (await svc.listRuns("ws-1"))[0]?.id;
		const res = await svc.stopRun("ws-1", runId);
		expect(res).toEqual({ ok: true });
		expect(orch.stopped).toEqual([]); // no abort on a completed run
	});

	it("stopRun throws for an unknown run id", async () => {
		const { svc } = createService({ orch: createFakeOrchestrator() });
		await expect(svc.stopRun("ws-1", "nope")).rejects.toThrow();
	});

	it("disabling the config stops the schedule (no further fires)", async () => {
		const orch = createFakeOrchestrator();
		const { svc, advance } = createService({ orch });
		await svc.updateConfig("ws-1", { enabled: true, taskPrompt: "go" });
		await svc.updateConfig("ws-1", { enabled: false });
		advance(60_000);
		expect(orch.pending).toHaveLength(0);
	});

	it("startAll sweeps stale running runs to stopped", async () => {
		const storage = createMemoryStorage();
		await storage.set(
			"run:ws-1:stale",
			JSON.stringify({
				id: "stale",
				conversationId: "c-stale",
				triggeredAt: "2026-01-01T00:00:00.000Z",
				status: "running",
			}),
		);
		await storage.set(
			"config:ws-1",
			JSON.stringify({
				enabled: false,
				systemPrompt: "",
				taskPrompt: "",
				intervalMinutes: 30,
				model: "",
				reasoningEffort: null,
			}),
		);

		const { svc } = createService({ orch: createFakeOrchestrator(), storage });
		await svc.startAll();
		expect((await svc.listRuns("ws-1"))[0]?.status).toBe("stopped");
	});

	it("startAll arms enabled workspaces and skips disabled ones", async () => {
		const orch = createFakeOrchestrator();
		const { svc: svc1, storage } = createService({ orch });
		await svc1.updateConfig("ws-1", { enabled: true, taskPrompt: "go", intervalMinutes: 1 });
		await svc1.updateConfig("ws-2", { enabled: false, taskPrompt: "no" });
		svc1.stopAll();

		// Re-create a fresh service over the SAME storage (simulates a reboot),
		// with new fake timers we can advance.
		const fake = createFakeTimers();
		let id = 1000;
		const svc2 = createHeartbeatService({
			storage,
			orchestrator: orch,
			timers: fake.timers,
			generateId: () => `id-${++id}`,
		});
		await svc2.startAll();
		fake.advance(60_000);
		await flush();
		expect(orch.pending.filter((t) => t.workspaceId === "ws-1")).toHaveLength(1);
		expect(orch.pending.filter((t) => t.workspaceId === "ws-2")).toHaveLength(0);
	});
});
