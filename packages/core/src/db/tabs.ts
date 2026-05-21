import { getDatabase } from "./index.js";

export interface TabRow {
	id: string;
	title: string;
	keyId: string | null;
	modelId: string | null;
	status: string;
	isOpen: boolean;
	position: number;
	createdAt: number;
	updatedAt: number;
}

function rowToTab(row: Record<string, unknown>): TabRow {
	return {
		id: row.id as string,
		title: row.title as string,
		keyId: row.key_id as string | null,
		modelId: row.model_id as string | null,
		status: row.status as string,
		isOpen: (row.is_open as number) === 1,
		position: row.position as number,
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

export function createTab(id: string, title: string): TabRow {
	const db = getDatabase();
	const now = Date.now();
	const maxPos = db.query("SELECT COALESCE(MAX(position), -1) as max_pos FROM tabs WHERE is_open = 1").get() as { max_pos: number };
	const position = (maxPos?.max_pos ?? -1) + 1;
	db.query(
		`INSERT INTO tabs (id, title, key_id, model_id, status, is_open, position, created_at, updated_at)
		 VALUES ($id, $title, NULL, NULL, 'idle', 1, $position, $now, $now)`,
	).run({ $id: id, $title: title, $position: position, $now: now });
	return { id, title, keyId: null, modelId: null, status: "idle", isOpen: true, position, createdAt: now, updatedAt: now };
}

export function getTab(id: string): TabRow | null {
	const db = getDatabase();
	const row = db.query("SELECT * FROM tabs WHERE id = $id").get({ $id: id }) as Record<string, unknown> | null;
	return row ? rowToTab(row) : null;
}

export function listOpenTabs(): TabRow[] {
	const db = getDatabase();
	const rows = db.query("SELECT * FROM tabs WHERE is_open = 1 ORDER BY position ASC").all() as Array<Record<string, unknown>>;
	return rows.map(rowToTab);
}

export function updateTabTitle(id: string, title: string): void {
	const db = getDatabase();
	db.query("UPDATE tabs SET title = $title, updated_at = $now WHERE id = $id").run({ $id: id, $title: title, $now: Date.now() });
}

export function updateTabModel(id: string, keyId: string | null, modelId: string | null): void {
	const db = getDatabase();
	db.query("UPDATE tabs SET key_id = $keyId, model_id = $modelId, updated_at = $now WHERE id = $id").run({
		$id: id, $keyId: keyId, $modelId: modelId, $now: Date.now(),
	});
}

export function updateTabStatus(id: string, status: string): void {
	const db = getDatabase();
	db.query("UPDATE tabs SET status = $status, updated_at = $now WHERE id = $id").run({ $id: id, $status: status, $now: Date.now() });
}

export function archiveTab(id: string): void {
	const db = getDatabase();
	db.query("UPDATE tabs SET is_open = 0, updated_at = $now WHERE id = $id").run({ $id: id, $now: Date.now() });
}
