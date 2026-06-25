/**
 * Heartbeat scheduler — the imperative timer loop.
 *
 * The scheduler owns NO knowledge of conversations, prompts, or the
 * orchestrator. It only manages per-workspace timers: when armed (a workspace's
 * heartbeat is `enabled`), it schedules a fire after `intervalMinutes`; when the
 * fire's work completes, it re-arms (resets the timer). This is the "reset timer
 * after each run" semantics — the interval is measured from run-completion to
 * the next fire, not a fixed wall-clock schedule.
 *
 * The actual run work (create a conversation, send the task prompt, track the
 * run) is the `fire(workspaceId)` callback, injected by the heartbeat service.
 * This keeps the scheduler pure-ish (only I/O is the injected timers) and
 * testable with fake timers + a fake fire.
 */

/** A handle returned by `setTimeout`, opaque to the scheduler. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** Injectable timers — the only I/O effect the scheduler touches. */
export interface Timers {
	readonly now: () => number;
	readonly setTimeout: (fn: () => void, ms: number) => TimerHandle;
	readonly clearTimeout: (handle: TimerHandle | undefined) => void;
}

/** The real timers (used at runtime; overridable in tests). */
export const realTimers: Timers = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => {
		if (handle !== undefined) clearTimeout(handle);
	},
};

export interface SchedulerDeps {
	readonly timers: Timers;
	/** Do the run work for a workspace. Resolves when the turn seals. */
	readonly fire: (workspaceId: string) => Promise<void>;
}

interface WorkspaceSchedule {
	/** Current interval (minutes), updated by `arm` on config changes. */
	intervalMinutes: number;
	/** Pending wait timer (null while a fire is in progress). */
	timer: TimerHandle | undefined;
	/** A fire is in progress for this workspace. */
	running: boolean;
	/** Scheduling is active (the workspace's heartbeat is enabled). */
	armed: boolean;
}

const MINUTE_MS = 60_000;

/**
 * Manages per-workspace heartbeat timers. A single instance is owned by the
 * heartbeat service for its lifetime.
 */
export class HeartbeatScheduler {
	private readonly schedules = new Map<string, WorkspaceSchedule>();
	private readonly timers: Timers;
	private readonly fire: (workspaceId: string) => Promise<void>;

	constructor(deps: SchedulerDeps) {
		this.timers = deps.timers;
		this.fire = deps.fire;
	}

	/**
	 * Arm (or re-arm) a workspace's schedule from its config. When `enabled`
	 * is false the schedule is disarmed. When a config update arrives while a
	 * run is in progress, the new `intervalMinutes` takes effect on the next
	 * re-arm (the in-progress run is never cancelled here).
	 */
	arm(workspaceId: string, config: {
		readonly enabled: boolean;
		readonly intervalMinutes: number;
	}): void {
		if (!config.enabled) {
			this.disarm(workspaceId);
			return;
		}
		let schedule = this.schedules.get(workspaceId);
		if (schedule === undefined) {
			schedule = { intervalMinutes: config.intervalMinutes, timer: undefined, running: false, armed: true };
			this.schedules.set(workspaceId, schedule);
		} else {
			schedule.intervalMinutes = config.intervalMinutes;
			schedule.armed = true;
		}
		// If a fire is in progress, let it finish — it will re-arm with the
		// (possibly new) interval. Otherwise schedule the next fire now.
		if (!schedule.running) {
			this.clearTimer(schedule);
			this.scheduleNext(workspaceId, schedule);
		}
	}

	/** Stop scheduling for a workspace (clears a pending timer; an in-progress run finishes on its own). */
	disarm(workspaceId: string): void {
		const schedule = this.schedules.get(workspaceId);
		if (schedule === undefined) return;
		schedule.armed = false;
		this.clearTimer(schedule);
		this.schedules.delete(workspaceId);
	}

	/** Stop all schedules (deactivate). */
	disarmAll(): void {
		for (const workspaceId of [...this.schedules.keys()]) {
			this.disarm(workspaceId);
		}
	}

	/** Whether a schedule is currently armed (enabled) for a workspace. */
	isArmed(workspaceId: string): boolean {
		return this.schedules.get(workspaceId)?.armed ?? false;
	}

	/** Whether a fire is currently in progress for a workspace. */
	isRunning(workspaceId: string): boolean {
		return this.schedules.get(workspaceId)?.running ?? false;
	}

	private scheduleNext(workspaceId: string, schedule: WorkspaceSchedule): void {
		const ms = Math.max(MINUTE_MS, schedule.intervalMinutes * MINUTE_MS);
		schedule.timer = this.timers.setTimeout(() => {
			this.onTick(workspaceId);
		}, ms);
	}

	private onTick(workspaceId: string): void {
		const schedule = this.schedules.get(workspaceId);
		// Race: the schedule was disarmed after the timer was queued.
		if (schedule === undefined || !schedule.armed) return;
		schedule.timer = undefined;
		schedule.running = true;
		this.fire(workspaceId)
			.catch(() => {
				// The service records the run outcome; a thrown fire is logged
				// by the service. Swallow so the loop continues.
			})
			.finally(() => {
				const current = this.schedules.get(workspaceId);
				if (current === undefined) return;
				current.running = false;
				if (current.armed) {
					this.scheduleNext(workspaceId, current);
				}
			});
	}

	private clearTimer(schedule: WorkspaceSchedule): void {
		if (schedule.timer !== undefined) {
			this.timers.clearTimeout(schedule.timer);
			schedule.timer = undefined;
		}
	}
}
