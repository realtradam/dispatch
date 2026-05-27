import type { Chunk, MessageRole } from "../types/index.js";
import { getDatabase } from "./index.js";

/**
 * A persisted message row, with `content_json` already parsed into a `Chunk[]`.
 * Mirrors the new schema (no `thinking` column — that lived under the old
 * `content + toolCalls + toolResults + thinking` model).
 */
export interface MessageRow {
	id: string;
	tabId: string;
	seq: number;
	role: MessageRole;
	chunks: Chunk[];
	createdAt: number;
}

/**
 * Append a new message to the tab. Caller passes the already-serialized
 * chunk list as `contentJson` (i.e. `JSON.stringify(chunks)`).
 */
export function appendMessage(
	tabId: string,
	id: string,
	role: MessageRole,
	contentJson: string,
): void {
	const db = getDatabase();
	const maxSeq = db
		.query("SELECT COALESCE(MAX(seq), -1) as max_seq FROM messages WHERE tab_id = $tabId")
		.get({ $tabId: tabId }) as { max_seq: number };
	const seq = (maxSeq?.max_seq ?? -1) + 1;
	db.query(
		`INSERT INTO messages (id, tab_id, seq, role, content_json, created_at)
		 VALUES ($id, $tabId, $seq, $role, $contentJson, $now)`,
	).run({
		$id: id,
		$tabId: tabId,
		$seq: seq,
		$role: role,
		$contentJson: contentJson,
		$now: Date.now(),
	});
}

/**
 * Replace the persisted chunks for an existing message. `contentJson` is
 * the already-serialized chunk list.
 */
export function updateMessage(id: string, contentJson: string): void {
	const db = getDatabase();
	db.query("UPDATE messages SET content_json = $contentJson WHERE id = $id").run({
		$id: id,
		$contentJson: contentJson,
	});
}

/**
 * Read all messages for a tab in seq order. `content_json` is parsed into
 * `Chunk[]` here so callers don't have to. If a row's JSON is malformed,
 * the message is returned with an empty chunk list rather than throwing.
 */
export function getMessagesForTab(tabId: string): MessageRow[] {
	const db = getDatabase();
	const rows = db
		.query("SELECT * FROM messages WHERE tab_id = $tabId ORDER BY seq ASC")
		.all({ $tabId: tabId }) as Array<Record<string, unknown>>;
	return rows.map((row) => {
		const rawJson = row.content_json as string;
		let chunks: Chunk[];
		try {
			const parsed = JSON.parse(rawJson);
			chunks = Array.isArray(parsed) ? (parsed as Chunk[]) : [];
		} catch {
			chunks = [];
		}
		return {
			id: row.id as string,
			tabId: row.tab_id as string,
			seq: row.seq as number,
			role: row.role as MessageRole,
			chunks,
			createdAt: row.created_at as number,
		};
	});
}

export function clearMessagesForTab(tabId: string): void {
	const db = getDatabase();
	db.query("DELETE FROM messages WHERE tab_id = $tabId").run({ $tabId: tabId });
}
