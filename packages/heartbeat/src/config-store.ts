import type { StorageNamespace } from "@dispatch/kernel";
import type { HeartbeatConfig, UpdateHeartbeatRequest } from "@dispatch/transport-contract";

/**
 * The default config returned for a workspace that has never configured a
 * heartbeat. A heartbeat is OFF until explicitly enabled.
 */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
	enabled: false,
	systemPrompt: "",
	taskPrompt: "",
	intervalMinutes: 30,
	model: "",
	reasoningEffort: null,
};

/** Minimum scheduling interval, in minutes (a heartbeat can't fire faster). */
export const MIN_INTERVAL_MINUTES = 1;

/** Storage key for a workspace's heartbeat config. */
function configKey(workspaceId: string): string {
	return `config:${workspaceId}`;
}

/**
 * Pure: apply a partial update to a config, returning the new config. Clamps
 * `intervalMinutes` to a minimum of 1 (a positive integer). Fields not present
 * in `update` are left unchanged. `reasoningEffort: null` clears the override
 * (back to inheriting the workspace default); `undefined` (absent) leaves it.
 *
 * Validation of `reasoningEffort` (rejecting unrecognized strings) is the
 * transport layer's job (→ HTTP 400); this function trusts a caller that has
 * already validated, but only ever produces a valid `HeartbeatConfig`.
 */
export function applyConfigUpdate(
	current: HeartbeatConfig,
	update: UpdateHeartbeatRequest,
): HeartbeatConfig {
	const next: HeartbeatConfig = {
		enabled: update.enabled !== undefined ? update.enabled : current.enabled,
		systemPrompt: update.systemPrompt !== undefined ? update.systemPrompt : current.systemPrompt,
		taskPrompt: update.taskPrompt !== undefined ? update.taskPrompt : current.taskPrompt,
		intervalMinutes:
			update.intervalMinutes !== undefined
				? Math.max(MIN_INTERVAL_MINUTES, Math.trunc(update.intervalMinutes))
				: current.intervalMinutes,
		model: update.model !== undefined ? update.model : current.model,
		reasoningEffort:
			update.reasoningEffort !== undefined ? update.reasoningEffort : current.reasoningEffort,
	};
	return next;
}

export interface HeartbeatConfigStore {
	/** The config for a workspace (the default when never set). */
	readonly get: (workspaceId: string) => Promise<HeartbeatConfig>;
	/** Apply a partial update and persist it; returns the new config. */
	readonly update: (
		workspaceId: string,
		update: UpdateHeartbeatRequest,
	) => Promise<HeartbeatConfig>;
	/** Every workspace id that has a persisted (non-default) config. */
	readonly listWorkspaceIds: () => Promise<readonly string[]>;
}

export function createHeartbeatConfigStore(
	storage: StorageNamespace,
): HeartbeatConfigStore {
	return {
		async get(workspaceId: string): Promise<HeartbeatConfig> {
			const raw = await storage.get(configKey(workspaceId));
			if (raw === null) return DEFAULT_HEARTBEAT_CONFIG;
			try {
				const parsed = JSON.parse(raw) as Partial<HeartbeatConfig>;
				return {
					enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : false,
					systemPrompt: typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : "",
					taskPrompt: typeof parsed.taskPrompt === "string" ? parsed.taskPrompt : "",
					intervalMinutes:
						typeof parsed.intervalMinutes === "number" && parsed.intervalMinutes > 0
							? Math.trunc(parsed.intervalMinutes)
							: DEFAULT_HEARTBEAT_CONFIG.intervalMinutes,
					model: typeof parsed.model === "string" ? parsed.model : "",
					reasoningEffort: parsed.reasoningEffort ?? null,
				};
			} catch {
				return DEFAULT_HEARTBEAT_CONFIG;
			}
		},

		async update(
			workspaceId: string,
			update: UpdateHeartbeatRequest,
		): Promise<HeartbeatConfig> {
			const current = await this.get(workspaceId);
			const next = applyConfigUpdate(current, update);
			await storage.set(configKey(workspaceId), JSON.stringify(next));
			return next;
		},

		async listWorkspaceIds(): Promise<readonly string[]> {
			const keys = await storage.keys("config:");
			const ids = keys.map((k) => k.slice("config:".length));
			// De-duplicate + sort for a stable boot-scan order.
			return [...new Set(ids)].sort();
		},
	};
}
