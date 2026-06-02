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

export function updateTabPositions(idsInOrder: string[]): void {
	const db = getDatabase();
	const now = Date.now();
	const update = db.query("UPDATE tabs SET position = $position, updated_at = $now WHERE id = $id");
	// One transaction so a reorder is atomic: either every tab lands at its new
	// slot or none does, never a half-applied ordering.
	const applyAll = db.transaction(() => {
		idsInOrder.forEach((id, index) => {
			update.run({ $id: id, $position: index, $now: now });
		});
	});
	applyAll();
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

/**
 * Minimum length of a tab-handle prefix accepted by `resolveTabPrefix`.
 * Mirrors the frontend's minimum DISPLAY length (4 hex chars). Anything
 * shorter is rejected as too broad — an agent must echo at least the 4-char
 * handle shown in the UI.
 */
export const MIN_TAB_PREFIX_LENGTH = 4;

/**
 * Outcome of resolving a short tab handle (a git-style prefix of a tab's
 * UUID) back to a concrete open tab.
 *
 *  - `ok`        — exactly one open tab matched; `tab` is it.
 *  - `none`      — no open tab matched (bad/stale handle, or too-short prefix).
 *  - `ambiguous` — more than one open tab shares the prefix; `matches` lists
 *                  them so the caller can ask for one more character (the same
 *                  UX as `git checkout <ambiguous-sha>`).
 */
export type ResolveTabPrefixResult =
	| { status: "ok"; tab: TabRow }
	| { status: "none" }
	| { status: "ambiguous"; matches: TabRow[] };

/**
 * Resolve a short tab handle to a single OPEN tab by prefix match — the
 * git-short-hash model. The handle is NEVER stored: it is always derived from
 * (and matched against) the canonical lowercase UUID in `tabs.id`.
 *
 * Sanitization is mandatory because the SQLite `LIKE` operator treats `%` and
 * `_` as wildcards: an unsanitized prefix like `a%` would match broadly. We
 * lowercase the input (UUIDs are canonical lowercase; SQLite `LIKE` is also
 * ASCII-case-insensitive by default) and strip everything outside the UUID
 * alphabet `[0-9a-f-]` so no wildcard can survive into the query.
 *
 * A prefix shorter than `MIN_TAB_PREFIX_LENGTH` after sanitization returns
 * `none` rather than matching a large swath of tabs.
 *
 * Only OPEN tabs (`is_open = 1`) are addressable — a closed tab's UUID prefix
 * must not cause phantom ambiguity or resolve to a dead conversation.
 */
export function resolveTabPrefix(prefix: string): ResolveTabPrefixResult {
	const sanitized = (prefix ?? "").toLowerCase().replace(/[^0-9a-f-]/g, "");
	if (sanitized.length < MIN_TAB_PREFIX_LENGTH) {
		return { status: "none" };
	}
	const db = getDatabase();
	const rows = db
		.query("SELECT * FROM tabs WHERE is_open = 1 AND id LIKE $prefix ORDER BY position ASC")
		.all({ $prefix: `${sanitized}%` }) as Array<Record<string, unknown>>;
	if (rows.length === 0) return { status: "none" };
	if (rows.length === 1) return { status: "ok", tab: rowToTab(rows[0] as Record<string, unknown>) };
	return { status: "ambiguous", matches: rows.map(rowToTab) };
}

/**
 * Compute the shortest unique prefix (minimum `MIN_TAB_PREFIX_LENGTH` chars)
 * that identifies `tabId` among the currently OPEN tabs — the backend twin of
 * the frontend's display helper. Used when a tool needs to echo a tab's own
 * handle (e.g. provenance prefixes, "available tabs" hints) without trusting a
 * value from the wire.
 *
 * Returns the full id if no shorter unique prefix exists (degenerate — only if
 * two open tabs share an entire id, which UUID uniqueness precludes).
 */
export function shortestUniquePrefix(tabId: string): string {
	const db = getDatabase();
	const rows = db.query("SELECT id FROM tabs WHERE is_open = 1").all() as Array<{ id: string }>;
	const others = rows.map((r) => r.id).filter((id) => id !== tabId);
	for (let len = MIN_TAB_PREFIX_LENGTH; len < tabId.length; len++) {
		const candidate = tabId.slice(0, len);
		if (!others.some((id) => id.startsWith(candidate))) return candidate;
	}
	return tabId;
}
