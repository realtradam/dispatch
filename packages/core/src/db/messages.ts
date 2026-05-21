import { getDatabase } from "./index.js";

export interface MessageRow {
	id: string;
	tabId: string;
	seq: number;
	role: string;
	contentJson: string;
	thinking: string | null;
	createdAt: number;
}

export function appendMessage(tabId: string, id: string, role: string, contentJson: string, thinking?: string): void {
	const db = getDatabase();
	const maxSeq = db.query("SELECT COALESCE(MAX(seq), -1) as max_seq FROM messages WHERE tab_id = $tabId").get({ $tabId: tabId }) as { max_seq: number };
	const seq = (maxSeq?.max_seq ?? -1) + 1;
	db.query(
		`INSERT INTO messages (id, tab_id, seq, role, content_json, thinking, created_at)
		 VALUES ($id, $tabId, $seq, $role, $contentJson, $thinking, $now)`,
	).run({ $id: id, $tabId: tabId, $seq: seq, $role: role, $contentJson: contentJson, $thinking: thinking ?? null, $now: Date.now() });
}

export function updateMessage(id: string, contentJson: string, thinking?: string): void {
	const db = getDatabase();
	db.query(
		"UPDATE messages SET content_json = $contentJson, thinking = $thinking WHERE id = $id",
	).run({ $id: id, $contentJson: contentJson, $thinking: thinking ?? null });
}

export function getMessagesForTab(tabId: string): MessageRow[] {
	const db = getDatabase();
	const rows = db.query("SELECT * FROM messages WHERE tab_id = $tabId ORDER BY seq ASC").all({ $tabId: tabId }) as Array<Record<string, unknown>>;
	return rows.map((row) => ({
		id: row.id as string,
		tabId: row.tab_id as string,
		seq: row.seq as number,
		role: row.role as string,
		contentJson: row.content_json as string,
		thinking: row.thinking as string | null,
		createdAt: row.created_at as number,
	}));
}

export function clearMessagesForTab(tabId: string): void {
	const db = getDatabase();
	db.query("DELETE FROM messages WHERE tab_id = $tabId").run({ $tabId: tabId });
}
