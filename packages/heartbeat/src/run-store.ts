import type { StorageNamespace } from "@dispatch/kernel";
import type { HeartbeatRun, HeartbeatRunStatus } from "@dispatch/transport-contract";

/** Storage key for a single heartbeat run record. */
function runKey(workspaceId: string, runId: string): string {
	return `run:${workspaceId}:${runId}`;
}

/** Prefix matching every run record for a workspace (for enumeration). */
function runPrefix(workspaceId: string): string {
	return `run:${workspaceId}:`;
}

/** Extract the runId from a full `run:<workspaceId>:<runId>` key. */
function parseRunId(key: string, workspaceId: string): string {
	const prefix = runPrefix(workspaceId);
	return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export interface HeartbeatRunStore {
	/** Create a new run record (status `"running"`) and persist it. */
	readonly create: (
		workspaceId: string,
		run: HeartbeatRun,
	) => Promise<HeartbeatRun>;
	/** Update the status of an existing run. No-op if the run is unknown. */
	readonly setStatus: (
		workspaceId: string,
		runId: string,
		status: HeartbeatRunStatus,
	) => Promise<HeartbeatRun | null>;
	/** A single run by id, or `null` when unknown. */
	readonly get: (workspaceId: string, runId: string) => Promise<HeartbeatRun | null>;
	/** All runs for a workspace, most-recent first (by `triggeredAt`). */
	readonly list: (workspaceId: string) => Promise<readonly HeartbeatRun[]>;
}

export function createHeartbeatRunStore(
	storage: StorageNamespace,
): HeartbeatRunStore {
	async function readRun(
		workspaceId: string,
		runId: string,
	): Promise<HeartbeatRun | null> {
		const raw = await storage.get(runKey(workspaceId, runId));
		if (raw === null) return null;
		try {
			const parsed = JSON.parse(raw) as Partial<HeartbeatRun>;
			if (
				typeof parsed.id !== "string" ||
				typeof parsed.conversationId !== "string" ||
				typeof parsed.triggeredAt !== "string" ||
				typeof parsed.status !== "string"
			) {
				return null;
			}
			return {
				id: parsed.id,
				conversationId: parsed.conversationId,
				triggeredAt: parsed.triggeredAt,
				status: parsed.status as HeartbeatRunStatus,
			};
		} catch {
			return null;
		}
	}

	return {
		async create(workspaceId: string, run: HeartbeatRun): Promise<HeartbeatRun> {
			await storage.set(runKey(workspaceId, run.id), JSON.stringify(run));
			return run;
		},

		async setStatus(
			workspaceId: string,
			runId: string,
			status: HeartbeatRunStatus,
		): Promise<HeartbeatRun | null> {
			const run = await readRun(workspaceId, runId);
			if (run === null) return null;
			const updated: HeartbeatRun = { ...run, status };
			await storage.set(runKey(workspaceId, runId), JSON.stringify(updated));
			return updated;
		},

		async get(workspaceId: string, runId: string): Promise<HeartbeatRun | null> {
			return readRun(workspaceId, runId);
		},

		async list(workspaceId: string): Promise<readonly HeartbeatRun[]> {
			const keys = await storage.keys(runPrefix(workspaceId));
			const runs: HeartbeatRun[] = [];
			for (const key of keys) {
				const runId = parseRunId(key, workspaceId);
				const run = await readRun(workspaceId, runId);
				if (run !== null) runs.push(run);
			}
			// Most-recent first by triggeredAt (ISO-8601 sorts lexicographically).
			runs.sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt));
			return runs;
		},
	};
}
