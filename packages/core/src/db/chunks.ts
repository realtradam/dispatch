import { randomUUID } from "node:crypto";
import {
	explodeTurn,
	explodeUserText,
	groupRowsToMessages,
	type MessageRow,
} from "../chunks/transform.js";
import type { ChunkData, ChunkRow, ChunkRowDraft, TextData } from "../types/index.js";
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
			.query("SELECT * FROM chunks WHERE tab_id = $tabId ORDER BY seq ASC")
			.all({ $tabId: tabId }) as Array<Record<string, unknown>>;
		return rows.map(mapRow);
	}
	const { limit, before } = options;
	if (before !== undefined) {
		if (limit !== undefined) {
			const rows = db
				.query(
					"SELECT * FROM chunks WHERE tab_id = $tabId AND seq < $before ORDER BY seq DESC LIMIT $limit",
				)
				.all({ $tabId: tabId, $before: before, $limit: limit }) as Array<Record<string, unknown>>;
			return rows.map(mapRow).reverse();
		}
		const rows = db
			.query("SELECT * FROM chunks WHERE tab_id = $tabId AND seq < $before ORDER BY seq DESC")
			.all({ $tabId: tabId, $before: before }) as Array<Record<string, unknown>>;
		return rows.map(mapRow).reverse();
	}
	if (limit !== undefined) {
		const rows = db
			.query("SELECT * FROM chunks WHERE tab_id = $tabId ORDER BY seq DESC LIMIT $limit")
			.all({ $tabId: tabId, $limit: limit }) as Array<Record<string, unknown>>;
		return rows.map(mapRow).reverse();
	}
	const rows = db
		.query("SELECT * FROM chunks WHERE tab_id = $tabId ORDER BY seq ASC")
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
		.query("SELECT COUNT(*) as count FROM chunks WHERE tab_id = $tabId")
		.get({ $tabId: tabId }) as { count: number } | null;
	return row?.count ?? 0;
}

export function clearChunksForTab(tabId: string): void {
	const db = getDatabase();
	db.query("DELETE FROM chunks WHERE tab_id = $tabId").run({ $tabId: tabId });
}
