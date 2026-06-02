import { randomUUID } from "node:crypto";
import {
	explodeTurn,
	explodeUserText,
	groupRowsToMessages,
	type MessageRow,
} from "../chunks/transform.js";
import type {
	ChunkData,
	ChunkRow,
	ChunkRowDraft,
	TextData,
	UsageData,
	UsageStats,
} from "../types/index.js";
import { getDatabase } from "./index.js";

// Re-export the DB-free transforms so existing barrel consumers
// (`@dispatch/core`) keep importing them from here. The browser frontend deep-
// imports them directly from `chunks/transform.js` to avoid the DB dependency.
export { explodeTurn, explodeUserText, groupRowsToMessages, type MessageRow };

// ─── Persistence ─────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): ChunkRow {
	let data: ChunkData;
	try {
		data = JSON.parse(row.data_json as string) as ChunkData;
	} catch {
		data = { text: "" } as TextData;
	}
	return {
		id: row.id as string,
		tabId: row.tab_id as string,
		seq: row.seq as number,
		turnId: row.turn_id as string,
		step: row.step as number,
		role: row.role as ChunkRow["role"],
		type: row.type as ChunkRow["type"],
		data,
		createdAt: row.created_at as number,
	};
}

/**
 * Append one or more chunk-row drafts to a tab, assigning a monotonic per-tab
 * `seq` and a fresh id/timestamp to each. Returns the inserted rows in order.
 */
export function appendChunks(tabId: string, drafts: ChunkRowDraft[]): ChunkRow[] {
	if (drafts.length === 0) return [];
	const db = getDatabase();
	const maxSeq = db
		.query("SELECT COALESCE(MAX(seq), -1) as max_seq FROM chunks WHERE tab_id = $tabId")
		.get({ $tabId: tabId }) as { max_seq: number };
	let seq = (maxSeq?.max_seq ?? -1) + 1;
	const now = Date.now();
	const insert = db.query(
		`INSERT INTO chunks (id, tab_id, seq, turn_id, step, role, type, data_json, created_at)
		 VALUES ($id, $tabId, $seq, $turnId, $step, $role, $type, $dataJson, $now)`,
	);
	const out: ChunkRow[] = [];
	// Wrap the whole batch in one transaction: a turn's chunks are persisted in
	// a single `appendChunks` call, so this is one fsync per turn instead of one
	// per row — the chosen low-IO write strategy for constrained backends.
	const insertAll = db.transaction(() => {
		for (const draft of drafts) {
			const id = randomUUID();
			insert.run({
				$id: id,
				$tabId: tabId,
				$seq: seq,
				$turnId: draft.turnId,
				$step: draft.step,
				$role: draft.role,
				$type: draft.type,
				$dataJson: JSON.stringify(draft.data),
				$now: now,
			});
			out.push({
				id,
				tabId,
				seq,
				turnId: draft.turnId,
				step: draft.step,
				role: draft.role,
				type: draft.type,
				data: draft.data,
				createdAt: now,
			});
			seq++;
		}
	});
	insertAll();
	return out;
}

/**
 * Read chunk rows for a tab in `seq` order (ASC). Pagination mirrors the old
 * message pagination but at chunk granularity:
 *   - no options → all rows;
 *   - `before` → rows with `seq < before`, most-recent-first then reversed;
 *   - `limit` → most recent `limit` rows, reversed to ASC.
 */
export function getChunksForTab(
	tabId: string,
	options?: { limit?: number; before?: number },
): ChunkRow[] {
	const db = getDatabase();
	if (!options) {
		const rows = db
			.query("SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' ORDER BY seq ASC")
			.all({ $tabId: tabId }) as Array<Record<string, unknown>>;
		return rows.map(mapRow);
	}
	const { limit, before } = options;
	if (before !== undefined) {
		if (limit !== undefined) {
			const rows = db
				.query(
					"SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' AND seq < $before ORDER BY seq DESC LIMIT $limit",
				)
				.all({ $tabId: tabId, $before: before, $limit: limit }) as Array<Record<string, unknown>>;
			return rows.map(mapRow).reverse();
		}
		const rows = db
			.query(
				"SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' AND seq < $before ORDER BY seq DESC",
			)
			.all({ $tabId: tabId, $before: before }) as Array<Record<string, unknown>>;
		return rows.map(mapRow).reverse();
	}
	if (limit !== undefined) {
		const rows = db
			.query(
				"SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' ORDER BY seq DESC LIMIT $limit",
			)
			.all({ $tabId: tabId, $limit: limit }) as Array<Record<string, unknown>>;
		return rows.map(mapRow).reverse();
	}
	const rows = db
		.query("SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' ORDER BY seq ASC")
		.all({ $tabId: tabId }) as Array<Record<string, unknown>>;
	return rows.map(mapRow);
}

/**
 * Derived, grouped view of a tab's full history as messages. Used to
 * pre-populate the agent's in-memory `ChatMessage[]` history when an Agent is
 * (re)constructed. Always reads the full log (grouping a partial window would
 * be lossy for the rebuild path).
 */
export function getMessagesForTab(tabId: string): MessageRow[] {
	return groupRowsToMessages(getChunksForTab(tabId));
}

export function getTotalChunkCount(tabId: string): number {
	const db = getDatabase();
	const row = db
		.query("SELECT COUNT(*) as count FROM chunks WHERE tab_id = $tabId AND type != 'usage'")
		.get({ $tabId: tabId }) as { count: number } | null;
	return row?.count ?? 0;
}

/**
 * Aggregate per-tab token/cache usage across ALL persisted `usage` chunk rows.
 *
 * Usage rows are written as an invisible side channel (one row per `usage`
 * AgentEvent) and are query-excluded from `getChunksForTab`/`getTotalChunkCount`,
 * so this aggregate is the read path. Because it sums server-side over every
 * row, it stays complete even after the frontend evicts/pages out old turns
 * (eviction is in-memory only). The return shape is structurally identical to
 * the frontend `CacheStats`, so reload can seed it directly.
 *
 *   - cumulative `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`
 *     = SUM over all usage rows;
 *   - `requests` = COUNT of usage rows;
 *   - `last` = the highest-seq usage row's split (most recent request);
 *   - `null` when the tab has no usage rows.
 *
 * Sums in JS after selecting the rows (mirroring `mapRow`) to avoid relying on
 * `json_extract` over the freeform `data_json`.
 */
export function getUsageStatsForTab(tabId: string): UsageStats | null {
	const db = getDatabase();
	const rows = db
		.query("SELECT data_json FROM chunks WHERE tab_id = $tabId AND type = 'usage' ORDER BY seq ASC")
		.all({ $tabId: tabId }) as Array<{ data_json: string }>;
	if (rows.length === 0) return null;

	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let last: UsageData | null = null;
	for (const row of rows) {
		let u: UsageData;
		try {
			u = JSON.parse(row.data_json) as UsageData;
		} catch {
			continue;
		}
		inputTokens += u.inputTokens ?? 0;
		outputTokens += u.outputTokens ?? 0;
		cacheReadTokens += u.cacheReadTokens ?? 0;
		cacheWriteTokens += u.cacheWriteTokens ?? 0;
		last = {
			inputTokens: u.inputTokens ?? 0,
			outputTokens: u.outputTokens ?? 0,
			cacheReadTokens: u.cacheReadTokens ?? 0,
			cacheWriteTokens: u.cacheWriteTokens ?? 0,
		};
	}

	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		requests: rows.length,
		last,
	};
}

export function clearChunksForTab(tabId: string): void {
	const db = getDatabase();
	db.query("DELETE FROM chunks WHERE tab_id = $tabId").run({ $tabId: tabId });
}

/**
 * Relocate every chunk row from one tab to another (compaction backup path).
 *
 * Used by conversation compaction to move the FULL pre-compaction history off
 * the canonical tab id (`fromTabId`) onto a freshly-created backup tab id
 * (`toTabId`), leaving the canonical id free to be re-seeded with the summary +
 * preserved tail. `seq` values are preserved (they remain per-tab monotonic for
 * the destination since it starts empty), as are turn ids, so the relocated
 * history groups identically under its new tab. Returns the number of rows
 * moved.
 */
export function rekeyChunks(fromTabId: string, toTabId: string): number {
	const db = getDatabase();
	const result = db
		.query("UPDATE chunks SET tab_id = $to WHERE tab_id = $from")
		.run({ $from: fromTabId, $to: toTabId });
	return Number(result.changes ?? 0);
}
