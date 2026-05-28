import { getDatabase } from "./index.js";

export interface TabRow {
	id: string;
	title: string;
	keyId: string | null;
	modelId: string | null;
	parentTabId: string | null;
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
		parentTabId: (row.parent_tab_id as string) ?? null,
		status: row.status as string,
		isOpen: (row.is_open as number) === 1,
		position: row.position as number,
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

export function createTab(
	id: string,
	title: string,
	options?: { keyId?: string | null; modelId?: string | null; parentTabId?: string | null },
): TabRow {
	const db = getDatabase();
	const now = Date.now();
	const maxPos = db
		.query("SELECT COALESCE(MAX(position), -1) as max_pos FROM tabs WHERE is_open = 1")
		.get() as { max_pos: number };
	const position = (maxPos?.max_pos ?? -1) + 1;
	const keyId = options?.keyId ?? null;
	const modelId = options?.modelId ?? null;
	const parentTabId = options?.parentTabId ?? null;
	db.query(
		`INSERT INTO tabs (id, title, key_id, model_id, parent_tab_id, status, is_open, position, created_at, updated_at)
		 VALUES ($id, $title, $keyId, $modelId, $parentTabId, 'idle', 1, $position, $now, $now)`,
	).run({
		$id: id,
		$title: title,
		$keyId: keyId,
		$modelId: modelId,
		$parentTabId: parentTabId,
		$position: position,
		$now: now,
	});
	return {
		id,
		title,
		keyId,
		modelId,
		parentTabId,
		status: "idle",
		isOpen: true,
		position,
		createdAt: now,
		updatedAt: now,
	};
}

export function getTab(id: string): TabRow | null {
	const db = getDatabase();
	const row = db.query("SELECT * FROM tabs WHERE id = $id").get({ $id: id }) as Record<
		string,
		unknown
	> | null;
	return row ? rowToTab(row) : null;
}

export function listOpenTabs(): TabRow[] {
	const db = getDatabase();
	const rows = db
		.query("SELECT * FROM tabs WHERE is_open = 1 ORDER BY position ASC")
		.all() as Array<Record<string, unknown>>;
	return rows.map(rowToTab);
}

export function updateTabTitle(id: string, title: string): void {
	const db = getDatabase();
	db.query("UPDATE tabs SET title = $title, updated_at = $now WHERE id = $id").run({
		$id: id,
		$title: title,
		$now: Date.now(),
	});
}

export function updateTabModel(id: string, keyId: string | null, modelId: string | null): void {
	const db = getDatabase();
	db.query(
		"UPDATE tabs SET key_id = $keyId, model_id = $modelId, updated_at = $now WHERE id = $id",
	).run({
		$id: id,
		$keyId: keyId,
		$modelId: modelId,
		$now: Date.now(),
	});
}

export function updateTabStatus(id: string, status: string): void {
	const db = getDatabase();
	db.query("UPDATE tabs SET status = $status, updated_at = $now WHERE id = $id").run({
		$id: id,
		$status: status,
		$now: Date.now(),
	});
}

export function archiveTab(id: string): void {
	const db = getDatabase();
	db.query("UPDATE tabs SET is_open = 0, updated_at = $now WHERE id = $id").run({
		$id: id,
		$now: Date.now(),
	});
}

/**
 * Return the IDs of `rootId` plus every OPEN descendant tab, in leaf-first
 * order (children before their parent). Archived descendants
 * (`is_open = 0`) and their sub-trees are skipped — closing a parent
 * shouldn't drag archived branches back into view.
 *
 * The starting `rootId` is always included in the result, even if no row
 * with that id exists in the `tabs` table (graceful handling for stale
 * references).
 *
 * Order matters for the cascade-close path: callers archive descendants
 * leaf-first so foreign-key cleanup (messages, etc.) doesn't fail on
 * partially-deleted parents.
 *
 * Cycle-safe: a `visited` set guards against accidental `parent_tab_id`
 * loops that would otherwise spin forever.
 */
export function getDescendantIds(rootId: string): string[] {
	const db = getDatabase();
	const visited = new Set<string>();
	const order: string[] = [];
	const queue: string[] = [rootId];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		if (visited.has(id)) continue;
		visited.add(id);
		order.push(id);
		const children = db
			.query("SELECT id FROM tabs WHERE parent_tab_id = $id AND is_open = 1")
			.all({ $id: id }) as Array<{ id: string }>;
		for (const child of children) {
			if (!visited.has(child.id)) queue.push(child.id);
		}
	}
	return order.reverse();
}
