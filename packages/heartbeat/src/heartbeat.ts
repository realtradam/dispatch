import type { Logger, ServiceHandle } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import type { SessionOrchestrator } from "@dispatch/session-orchestrator";
import type {
	HeartbeatConfig,
	HeartbeatRun,
	StopHeartbeatRunResponse,
	UpdateHeartbeatRequest,
} from "@dispatch/transport-contract";
import {
	type HeartbeatConfigStore,
	createHeartbeatConfigStore,
} from "./config-store.js";
import { type HeartbeatRunStore, createHeartbeatRunStore } from "./run-store.js";
import { HeartbeatScheduler, type Timers, realTimers } from "./scheduler.js";

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
	 * Stop an in-flight run (abort its turn). Idempotent for an already-finished
	 * run. Throws when the run id is unknown (→ HTTP 404).
	 */
	readonly stopRun: (
		workspaceId: string,
		runId: string,
	) => Promise<StopHeartbeatRunResponse>;
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

		try {
			await orchestrator.handleMessage({
				conversationId,
				text: config.taskPrompt,
				// Fire-and-forget: the heartbeat loop does not consume the
				// streamed events (it only awaits turn completion to mark the
				// run done). A no-op onEvent satisfies the required callback.
				onEvent: () => {},
				// Always an explicit override (incl. the empty string = no system
				// prompt) — bypasses the templated workspace prompt.
				systemPrompt: config.systemPrompt,
				...(config.model !== "" ? { modelName: config.model } : {}),
				...(config.reasoningEffort !== null ? { reasoningEffort: config.reasoningEffort } : {}),
				workspaceId,
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
