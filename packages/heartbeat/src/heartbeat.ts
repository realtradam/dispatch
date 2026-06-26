import type { Logger, ServiceHandle } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import type { SessionOrchestrator } from "@dispatch/session-orchestrator";
import type {
	HeartbeatConfig,
	HeartbeatRun,
	StopHeartbeatRunResponse,
	UpdateHeartbeatRequest,
} from "@dispatch/transport-contract";
import { createHeartbeatConfigStore, type HeartbeatConfigStore } from "./config-store.js";
import { createHeartbeatRunStore, type HeartbeatRunStore } from "./run-store.js";
import { HeartbeatScheduler, realTimers, type Timers } from "./scheduler.js";

/**
 * The dedicated workspace heartbeat-spawned conversations are filed in (NOT the
 * configured workspace). The config + run history stay per-workspace (tracked
 * under the configured workspaceId); only the spawned conversation's PLACEMENT
 * moves here, so heartbeat conversations don't clog the configured workspace's
 * tabs. The orchestrator auto-creates this workspace on first fire (via
 * `ensureWorkspace`), so it appears on the workspaces home page like any other.
 */
export const HEARTBEAT_WORKSPACE_ID = "heartbeat";

/**
 * The heartbeat service surface — what transport-http consumes and what the
 * extension wires into the host.
 */
export interface HeartbeatService {
	/** The per-workspace heartbeat config (defaults when never set). */
	readonly getConfig: (workspaceId: string) => Promise<HeartbeatConfig>;
	/**
	 * Apply a partial config update. Side effect: arms/disarms the scheduler
	 * for this workspace (enabled → schedule; disabled → stop). Returns the new
	 * config.
	 */
	readonly updateConfig: (
		workspaceId: string,
		update: UpdateHeartbeatRequest,
	) => Promise<HeartbeatConfig>;
	/** Heartbeat runs for a workspace, most-recent first. */
	readonly listRuns: (workspaceId: string) => Promise<readonly HeartbeatRun[]>;
	/**
	 * The server-authoritative next-fire time for a workspace's heartbeat, as
	 * an ISO 8601 string — the moment the scheduler will fire the next run
	 * (the last run's completion + `intervalMinutes`, or the moment `enabled`
	 * was toggled on + `intervalMinutes` for the first run). `null` when the
	 * heartbeat is disabled/disarmed, or when a run is in flight and the next
	 * hasn't been queued yet (no countdown to show). A cheap read of the
	 * scheduler's pending fire time.
	 */
	readonly nextRunAt: (workspaceId: string) => Promise<string | null>;
	/**
	 * Stop an in-flight run (abort its turn). Idempotent for an already-finished
	 * run. Throws when the run id is unknown (→ HTTP 404).
	 */
	readonly stopRun: (workspaceId: string, runId: string) => Promise<StopHeartbeatRunResponse>;
	/** Boot: sweep stale runs + arm every enabled workspace's scheduler. */
	readonly startAll: () => Promise<void>;
	/** Shutdown: stop every scheduler. */
	readonly stopAll: () => void;
}

/** Typed service handle the heartbeat extension provides and transport consumes. */
export const heartbeatServiceHandle: ServiceHandle<HeartbeatService> =
	defineService<HeartbeatService>("heartbeat");

export interface HeartbeatServiceDeps {
	/** Namespaced storage (from `host.storage("heartbeat")`). */
	readonly storage: import("@dispatch/kernel").StorageNamespace;
	/** The session orchestrator (drives heartbeat turns). */
	readonly orchestrator: SessionOrchestrator;
	readonly logger?: Logger;
	/** Injectable timers (default: real). */
	readonly timers?: Timers;
	/** Injectable id generator (default: crypto.randomUUID). */
	readonly generateId?: () => string;
	/**
	 * Resolve `[type:name]` variable placeholders in a prompt template against
	 * the current environment — the SAME resolver + variable catalog the global
	 * system-prompt template uses (system/file/prompt/git groups). Applied once
	 * per run, when the turn is constructed (mirrors the global template's
	 * construct-once-per-conversation resolution). When omitted, templates pass
	 * through UNRESOLVED (raw) — the extension wires the real resolver; tests
	 * inject a fake.
	 */
	readonly resolvePrompt?: (
		template: string,
		ctx: {
			readonly workspaceId: string;
			readonly conversationId: string;
			readonly model: string;
		},
	) => Promise<string>;
	/**
	 * Resolve an empty heartbeat `systemPrompt` to the GLOBAL system prompt
	 * template — the same one `GET /system-prompt` returns / that regular
	 * conversations resolve. Applied ONLY when the heartbeat's persisted
	 * `systemPrompt` is `""` (inherit), and BEFORE variable resolution
	 * (`resolvePrompt` / CR-HB-1) runs on the result, so both apply in order:
	 * empty ⇒ global template, then `[type:name]` placeholders resolved. A
	 * non-empty `systemPrompt` is an explicit override and bypasses this.
	 * When omitted, empty stays empty (no system prompt) — the extension
	 * wires the real getter; tests inject a fake.
	 */
	readonly getGlobalSystemPrompt?: () => Promise<string>;
	/**
	 * The configured workspace's `defaultCwd` (or `null` when the workspace has
	 * none). Used to pin the heartbeat turn's cwd to the CONFIGURED workspace's
	 * directory — NOT the heartbeat workspace's (empty) defaultCwd — so the
	 * turn's tools run in the same directory the prompt's `[prompt:cwd]`
	 * variable advertises. Passed to the orchestrator as an explicit `cwd`
	 * override only when non-null; when `null` no override is sent and the
	 * orchestrator falls back to the server default cwd (matching the
	 * pre-heartbeat-workspace behavior for a workspace without a defaultCwd).
	 * When omitted, `null` (no override) — the extension wires the real getter
	 * (against `conversationStore.getWorkspace`); tests inject a fake.
	 */
	readonly getWorkspaceCwd?: (workspaceId: string) => Promise<string | null>;
}

interface ActiveRun {
	readonly conversationId: string;
	readonly workspaceId: string;
	stopped: boolean;
}

export function createHeartbeatService(deps: HeartbeatServiceDeps): HeartbeatService {
	const logger = deps.logger;
	const timers = deps.timers ?? realTimers;
	const generateId = deps.generateId ?? (() => crypto.randomUUID());
	const configStore: HeartbeatConfigStore = createHeartbeatConfigStore(deps.storage);
	const runStore: HeartbeatRunStore = createHeartbeatRunStore(deps.storage);
	const orchestrator = deps.orchestrator;
	// Default: pass templates through UNRESOLVED (raw). The extension wires the
	// real resolver so [type:name] placeholders are substituted like the global
	// system-prompt template; tests inject a fake.
	const resolvePrompt = deps.resolvePrompt ?? ((template: string) => Promise.resolve(template));
	// Default: an empty systemPrompt stays empty (no system prompt). The
	// extension wires the real getter so empty INHERITS the global system
	// prompt template (GET /system-prompt); tests inject a fake.
	const getGlobalSystemPrompt = deps.getGlobalSystemPrompt ?? (() => Promise.resolve(""));
	// Default: no cwd override (the orchestrator resolves the turn cwd from the
	// conversation's workspace). The extension wires the real getter so the
	// turn pins to the CONFIGURED workspace's defaultCwd; tests inject a fake.
	const getWorkspaceCwd = deps.getWorkspaceCwd ?? (() => Promise.resolve(null));

	// runId → active-run tracking (in-memory; the durable record lives in the
	// run store). Used to (a) map a stop request to its conversation, and
	// (b) keep a "stopped" flag so the turn's completion doesn't clobber a
	// user-initiated stop.
	const activeRuns = new Map<string, ActiveRun>();

	const scheduler = new HeartbeatScheduler({
		timers,
		fire: (workspaceId) => fire(workspaceId),
	});

	async function fire(workspaceId: string): Promise<void> {
		const config = await configStore.get(workspaceId);
		// Race: disabled/disarmed between the timer firing and now.
		if (!config.enabled) return;

		const conversationId = generateId();
		const runId = generateId();
		const triggeredAt = new Date(timers.now()).toISOString();
		const run: HeartbeatRun = {
			id: runId,
			conversationId,
			triggeredAt,
			status: "running",
		};
		await runStore.create(workspaceId, run);
		activeRuns.set(runId, { conversationId, workspaceId, stopped: false });

		logger?.info("heartbeat: run started", { workspaceId, runId, conversationId });

		// Resolve the heartbeat's prompts ONCE, when the turn is constructed.
		//
		// CR-HB-2: an empty `systemPrompt` INHERITS the global system prompt
		// template (the same one `GET /system-prompt` returns / that regular
		// conversations resolve) — empty is an override-means-inherit flag, not
		// "no system prompt". A non-empty `systemPrompt` is an explicit override.
		// This step runs FIRST.
		//
		// CR-HB-1: then `[type:name]` variable placeholders in whichever prompt is
		// in effect are resolved via the same resolver + variable catalog the
		// global system-prompt template uses. The orchestrator sends an explicit
		// systemPrompt override AS-IS (bypassing its own templated prompt), so
		// resolution must happen HERE, before handleMessage. For prompts using
		// stable variables (os/cwd/git) this yields a stable, cache-warm prompt
		// across runs; time-bearing variables refresh per run (mirroring the
		// global template's per-conversation resolution).
		const baseSystemPrompt =
			config.systemPrompt === "" ? await getGlobalSystemPrompt() : config.systemPrompt;
		const resolveCtx = { workspaceId, conversationId, model: config.model };
		// resolveCtx uses the CONFIGURED workspaceId — the heartbeat operates
		// ON BEHALF OF the configured workspace, so `[prompt:workspace_id]` and
		// `[prompt:cwd]` refer to it (not the heartbeat workspace the spawned
		// conversation is filed in). The turn's cwd is pinned to the SAME
		// configured workspace's defaultCwd (below) so tools run where the
		// prompt's `[prompt:cwd]` advertises.
		const [systemPrompt, taskPrompt, configuredWorkspaceCwd] = await Promise.all([
			resolvePrompt(baseSystemPrompt, resolveCtx),
			resolvePrompt(config.taskPrompt, resolveCtx),
			getWorkspaceCwd(workspaceId),
		]);

		try {
			await orchestrator.handleMessage({
				conversationId,
				text: taskPrompt,
				// Fire-and-forget: the heartbeat loop does not consume the
				// streamed events (it only awaits turn completion to mark the
				// run done). A no-op onEvent satisfies the required callback.
				onEvent: () => {},
				// Always passed explicitly — bypasses the orchestrator's templated
				// workspace prompt. Resolved above: an empty config systemPrompt
				// inherited the global template (CR-HB-2), then [type:name]
				// placeholders were substituted (CR-HB-1). Still "" when the global
				// template itself is empty (no system prompt).
				systemPrompt,
				...(config.model !== "" ? { modelName: config.model } : {}),
				...(config.reasoningEffort !== null ? { reasoningEffort: config.reasoningEffort } : {}),
				// Pin the turn cwd to the CONFIGURED workspace's defaultCwd so
				// the heartbeat's tools run in the same directory its prompt
				// variables advertise — NOT the heartbeat workspace's (empty)
				// defaultCwd → process.cwd(). Omitted when the configured
				// workspace has no defaultCwd (the orchestrator then falls back
				// to the server default cwd, matching the pre-heartbeat-
				// workspace behavior for a workspace without one).
				...(configuredWorkspaceCwd !== null ? { cwd: configuredWorkspaceCwd } : {}),
				// File the spawned conversation in the DEDICATED heartbeat
				// workspace (not the configured workspace) so heartbeat
				// conversations don't clog the configured workspace's tabs. The
				// orchestrator auto-creates this workspace on first fire
				// (ensureWorkspace), so it appears on the workspaces home page.
				workspaceId: HEARTBEAT_WORKSPACE_ID,
			});
		} finally {
			const entry = activeRuns.get(runId);
			activeRuns.delete(runId);
			// If the user stopped it, stopRun already set "stopped"; don't
			// clobber. Otherwise the turn sealed (normally or via abort) → done.
			if (entry !== undefined && !entry.stopped) {
				await runStore.setStatus(workspaceId, runId, "completed");
				logger?.info("heartbeat: run completed", { workspaceId, runId });
			}
		}
	}

	return {
		async getConfig(workspaceId) {
			return configStore.get(workspaceId);
		},

		async updateConfig(workspaceId, update) {
			const next = await configStore.update(workspaceId, update);
			// Arm/disarm from the new config. An in-progress run is left alone;
			// the new interval takes effect on the next re-arm.
			scheduler.arm(workspaceId, next);
			logger?.info("heartbeat: config updated", {
				workspaceId,
				enabled: next.enabled,
				intervalMinutes: next.intervalMinutes,
			});
			return next;
		},

		async listRuns(workspaceId) {
			return runStore.list(workspaceId);
		},

		async nextRunAt(workspaceId) {
			const ms = scheduler.nextFireAt(workspaceId);
			return ms === null ? null : new Date(ms).toISOString();
		},

		async stopRun(workspaceId, runId) {
			const run = await runStore.get(workspaceId, runId);
			if (run === null) {
				throw new Error("Heartbeat run not found");
			}
			// Idempotent: an already-finished run is a no-op.
			if (run.status !== "running") {
				return { ok: true };
			}
			const entry = activeRuns.get(runId);
			const conversationId = entry?.conversationId ?? run.conversationId;
			if (entry !== undefined) {
				entry.stopped = true;
			}
			await runStore.setStatus(workspaceId, runId, "stopped");
			orchestrator.stopTurn(conversationId);
			logger?.info("heartbeat: run stopped", { workspaceId, runId, conversationId });
			return { ok: true };
		},

		async startAll() {
			// Sweep stale "running" runs (orphaned by a prior crash/restart) →
			// "stopped". Never leave the system showing an in-flight run that
			// can never finish.
			const workspaceIds = await configStore.listWorkspaceIds();
			for (const workspaceId of workspaceIds) {
				const runs = await runStore.list(workspaceId);
				for (const run of runs) {
					if (run.status === "running") {
						await runStore.setStatus(workspaceId, run.id, "stopped");
					}
				}
				const config = await configStore.get(workspaceId);
				if (config.enabled) {
					scheduler.arm(workspaceId, config);
					logger?.info("heartbeat: scheduler armed on boot", {
						workspaceId,
						intervalMinutes: config.intervalMinutes,
					});
				}
			}
		},

		stopAll() {
			scheduler.disarmAll();
		},
	};
}
