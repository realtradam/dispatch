import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Internal row shape — matches the production `tabs` table columns.
 * Kept loose (`Record`) on the `query()` boundary to mirror bun:sqlite's
 * dynamic return type.
 */
interface TabRow {
	id: string;
	title: string;
	key_id: string | null;
	model_id: string | null;
	parent_tab_id: string | null;
	status: string;
	is_open: number;
	position: number;
	created_at: number;
	updated_at: number;
}

/**
 * In-memory fake of `bun:sqlite`'s Database that implements only the
 * queries actually issued by `tabs.ts`. This sidesteps two problems
 * the original test had:
 *   1. Vite's resolver can't load `bun:sqlite` (it's a Bun-native
 *      module with no on-disk file).
 *   2. Even under `bun --bun vitest`, `vi.mock` doesn't intercept
 *      module imports because Bun's loader bypasses Vite's transforms.
 *
 * By implementing the exact query strings as fixed branches we avoid
 * writing an SQL parser; if `tabs.ts` ever changes a query string,
 * tests will fail loudly with "Unsupported query" instead of
 * silently returning wrong data.
 */
class FakeDatabase {
	rows: TabRow[] = [];

	/** Match production's `db.query(sql).get|all|run(params)` shape. */
	query(sql: string): {
		all: (params?: Record<string, unknown>) => unknown[];
		get: (params?: Record<string, unknown>) => unknown;
		run: (params?: Record<string, unknown>) => void;
	} {
		return {
			all: (params) => this.execSelect(sql, params),
			get: (params) => this.execSelect(sql, params)[0] ?? null,
			run: (params) => {
				this.execMutation(sql, params);
			},
		};
	}

	/**
	 * Match Bun's `db.transaction(fn)` shape: returns a callable that runs
	 * `fn` synchronously. The fake is in-memory and single-threaded, so we
	 * don't emulate rollback — callers just need the wrapper to be invocable.
	 */
	transaction(fn: () => void): () => void {
		return () => fn();
	}

	private execSelect(sql: string, params?: Record<string, unknown>): unknown[] {
		const norm = sql.replace(/\s+/g, " ").trim();

		// getDescendantIds: children-of query
		if (norm === "SELECT id FROM tabs WHERE parent_tab_id = $id AND is_open = 1") {
			return this.rows
				.filter((r) => r.parent_tab_id === params?.$id && r.is_open === 1)
				.map((r) => ({ id: r.id }));
		}

		// getTab: single-row lookup
		if (norm === "SELECT * FROM tabs WHERE id = $id") {
			const row = this.rows.find((r) => r.id === params?.$id);
			return row ? [row] : [];
		}

		// createTab: next-position lookup
		if (norm === "SELECT COALESCE(MAX(position), -1) as max_pos FROM tabs WHERE is_open = 1") {
			const positions = this.rows.filter((r) => r.is_open === 1).map((r) => r.position);
			const maxPos = positions.length > 0 ? Math.max(...positions) : -1;
			return [{ max_pos: maxPos }];
		}

		// resolveTabPrefix: open tabs whose id starts with a sanitized prefix.
		// The production query binds `$prefix` as `<sanitized>%`; emulate SQLite
		// LIKE prefix semantics here (case-insensitive, `%` = "rest of string").
		if (norm === "SELECT * FROM tabs WHERE is_open = 1 AND id LIKE $prefix ORDER BY position ASC") {
			const raw = String(params?.$prefix ?? "");
			const needle = raw.endsWith("%") ? raw.slice(0, -1) : raw;
			return this.rows
				.filter((r) => r.is_open === 1 && r.id.toLowerCase().startsWith(needle.toLowerCase()))
				.sort((a, b) => a.position - b.position);
		}

		// shortestUniquePrefix: all open tab ids.
		if (norm === "SELECT id FROM tabs WHERE is_open = 1") {
			return this.rows.filter((r) => r.is_open === 1).map((r) => ({ id: r.id }));
		}

		// listOpenTabs: every open tab ordered by position.
		if (norm === "SELECT * FROM tabs WHERE is_open = 1 ORDER BY position ASC") {
			return this.rows.filter((r) => r.is_open === 1).sort((a, b) => a.position - b.position);
		}

		throw new Error(`FakeDatabase: unsupported SELECT: ${norm}`);
	}

	private execMutation(sql: string, params?: Record<string, unknown>): void {
		const norm = sql.replace(/\s+/g, " ").trim();

		// createTab: full-row insert (every column named, $-bound params)
		if (
			norm ===
			"INSERT INTO tabs (id, title, key_id, model_id, parent_tab_id, status, is_open, position, created_at, updated_at) VALUES ($id, $title, $keyId, $modelId, $parentTabId, 'idle', 1, $position, $now, $now)"
		) {
			const id = params?.$id as string;
			if (this.rows.some((r) => r.id === id)) {
				throw new Error(`UNIQUE constraint failed: tabs.id (${id})`);
			}
			this.rows.push({
				id,
				title: (params?.$title as string) ?? "",
				key_id: (params?.$keyId as string | null) ?? null,
				model_id: (params?.$modelId as string | null) ?? null,
				parent_tab_id: (params?.$parentTabId as string | null) ?? null,
				status: "idle",
				is_open: 1,
				position: (params?.$position as number) ?? 0,
				created_at: (params?.$now as number) ?? 0,
				updated_at: (params?.$now as number) ?? 0,
			});
			return;
		}

		// archiveTab: flip is_open to 0
		if (norm === "UPDATE tabs SET is_open = 0, updated_at = $now WHERE id = $id") {
			const row = this.rows.find((r) => r.id === params?.$id);
			if (row) {
				row.is_open = 0;
				row.updated_at = (params?.$now as number) ?? Date.now();
			}
			return;
		}

		// updateTabPositions: rewrite a single tab's position (run per id inside a txn)
		if (norm === "UPDATE tabs SET position = $position, updated_at = $now WHERE id = $id") {
			const row = this.rows.find((r) => r.id === params?.$id);
			if (row) {
				row.position = (params?.$position as number) ?? row.position;
				row.updated_at = (params?.$now as number) ?? Date.now();
			}
			return;
		}

		throw new Error(`FakeDatabase: unsupported mutation: ${norm}`);
	}
}

/**
 * Shared instance referenced by both the test setup and the
 * `vi.mock` factory below. Declared with `let` (not `const`) so the
 * factory's closure picks up the value assigned in `beforeAll`.
 */
let fakeDb: FakeDatabase;

// Mock the db module before importing `tabs.ts` so that `getDatabase()`
// returns our in-memory fake instead of trying to open a real SQLite
// file. Mirrors the same pattern used by `tests/agent/agent.test.ts`.
vi.mock("../../src/db/index.js", () => ({
	getDatabase: vi.fn(() => fakeDb),
}));

// Dynamic import AFTER `vi.mock` registers (vitest hoists `vi.mock` to
// the very top of the file, so by the time this line runs the mock is
// active for `./index.js` resolution inside `tabs.ts`).
const {
	archiveTab,
	createTab,
	getDescendantIds,
	getTab,
	listOpenTabs,
	resolveTabPrefix,
	shortestUniquePrefix,
	updateTabPositions,
} = await import("../../src/db/tabs.js");

beforeAll(() => {
	fakeDb = new FakeDatabase();
});

beforeEach(() => {
	fakeDb.rows = [];
});

// ---------------------------------------------------------------------------
// getDescendantIds
// ---------------------------------------------------------------------------
describe("getDescendantIds", () => {
	it("returns only the id when the tab has no children", () => {
		createTab("root", "Root");

		const ids = getDescendantIds("root");
		expect(ids).toEqual(["root"]);
	});

	it("returns leaf-first order for a linear chain (root → child → grandchild)", () => {
		createTab("root", "Root");
		createTab("child", "Child", { parentTabId: "root" });
		createTab("grandchild", "Grandchild", { parentTabId: "child" });

		const ids = getDescendantIds("root");
		// Leaves first: grandchild, child, root
		expect(ids).toEqual(["grandchild", "child", "root"]);
	});

	it("returns leaf-first for a branching tree", () => {
		createTab("a", "A");
		createTab("b1", "B1", { parentTabId: "a" });
		createTab("b2", "B2", { parentTabId: "a" });
		createTab("c1", "C1", { parentTabId: "b1" });
		createTab("c2", "C2", { parentTabId: "b1" });

		const ids = getDescendantIds("a");
		// BFS: a, b1, b2, c1, c2  →  reverse: c2, c1, b2, b1, a
		expect(ids).toEqual(["c2", "c1", "b2", "b1", "a"]);
	});

	it("skips archived descendants (is_open = 0)", () => {
		createTab("root", "Root");
		// Open child of root — should appear
		createTab("open-child", "Open", { parentTabId: "root" });
		// Archived child — should be skipped together with its descendants
		createTab("archived-child", "Archived", { parentTabId: "root" });
		archiveTab("archived-child");
		// Child of archived — data drift, should NOT appear (parent is archived)
		createTab("orphan", "Orphan", { parentTabId: "archived-child" });

		const ids = getDescendantIds("root");
		expect(ids).toEqual(["open-child", "root"]);
		expect(ids).not.toContain("archived-child");
		expect(ids).not.toContain("orphan");
	});

	it("handles a non-existent id gracefully", () => {
		const ids = getDescendantIds("does-not-exist");
		expect(ids).toEqual(["does-not-exist"]);
	});

	it("defends against accidental parent_tab_id cycles", () => {
		// Insert x first with a forward reference to y (y doesn't exist
		// yet — the schema has no foreign key enforcement). Then insert
		// y with parent_tab_id = x. Result: x.parent = y, y.parent = x.
		createTab("x", "X", { parentTabId: "y" });
		createTab("y", "Y", { parentTabId: "x" });

		// Must terminate — no infinite loop
		const ids = getDescendantIds("x");
		expect(ids).toContain("x");
		expect(ids).toContain("y");
		expect(ids).toHaveLength(2);
	});

	it("uses createTab helper and asserts is_open flag", () => {
		createTab("a1", "A1");
		createTab("b1", "B1", { parentTabId: "a1" });
		createTab("c1", "C1", { parentTabId: "b1" });

		// All three should be open
		expect(getTab("a1")?.isOpen).toBe(true);
		expect(getTab("b1")?.isOpen).toBe(true);
		expect(getTab("c1")?.isOpen).toBe(true);

		// getDescendantIds sees all three
		const ids = getDescendantIds("a1");
		expect(ids).toEqual(["c1", "b1", "a1"]);

		// Archive the leaf, then it should disappear
		archiveTab("c1");
		expect(getTab("c1")?.isOpen).toBe(false);

		const ids2 = getDescendantIds("a1");
		expect(ids2).toEqual(["b1", "a1"]);
	});
});

// ---------------------------------------------------------------------------
// resolveTabPrefix — git-style short-handle resolution
// ---------------------------------------------------------------------------
describe("resolveTabPrefix", () => {
	it("returns none when the prefix is shorter than the minimum length", () => {
		createTab("abcd1234-0000-4000-8000-000000000000", "A");
		// 3 chars < MIN_TAB_PREFIX_LENGTH (4)
		expect(resolveTabPrefix("abc").status).toBe("none");
	});

	it("returns none when no open tab matches", () => {
		createTab("abcd1234-0000-4000-8000-000000000000", "A");
		expect(resolveTabPrefix("ffff").status).toBe("none");
	});

	it("resolves a unique 4-char prefix to the single matching tab", () => {
		createTab("abcd1234-0000-4000-8000-000000000000", "Alpha");
		createTab("9999aaaa-0000-4000-8000-000000000000", "Beta");
		const res = resolveTabPrefix("abcd");
		expect(res.status).toBe("ok");
		if (res.status === "ok") {
			expect(res.tab.id).toBe("abcd1234-0000-4000-8000-000000000000");
			expect(res.tab.title).toBe("Alpha");
		}
	});

	it("resolves the full UUID (a maximal prefix)", () => {
		createTab("abcd1234-0000-4000-8000-000000000000", "Alpha");
		const res = resolveTabPrefix("abcd1234-0000-4000-8000-000000000000");
		expect(res.status).toBe("ok");
	});

	it("reports ambiguity when multiple open tabs share the prefix", () => {
		createTab("abcd1111-0000-4000-8000-000000000000", "One");
		createTab("abcd2222-0000-4000-8000-000000000000", "Two");
		const res = resolveTabPrefix("abcd");
		expect(res.status).toBe("ambiguous");
		if (res.status === "ambiguous") {
			expect(res.matches).toHaveLength(2);
			expect(res.matches.map((m) => m.title).sort()).toEqual(["One", "Two"]);
		}
	});

	it("disambiguates when one more character is supplied", () => {
		createTab("abcd1111-0000-4000-8000-000000000000", "One");
		createTab("abcd2222-0000-4000-8000-000000000000", "Two");
		const res = resolveTabPrefix("abcd1");
		expect(res.status).toBe("ok");
		if (res.status === "ok") expect(res.tab.title).toBe("One");
	});

	it("matches case-insensitively (UUIDs are lowercase; LIKE is ASCII-CI)", () => {
		createTab("abcd1234-0000-4000-8000-000000000000", "Alpha");
		const res = resolveTabPrefix("ABCD");
		expect(res.status).toBe("ok");
	});

	it("sanitizes LIKE wildcards so they cannot broaden the match", () => {
		createTab("abcd1234-0000-4000-8000-000000000000", "Alpha");
		createTab("9999aaaa-0000-4000-8000-000000000000", "Beta");
		// `%` would match everything if not stripped; after sanitization the
		// query is effectively `abcd%` which matches only Alpha.
		const res = resolveTabPrefix("ab%d");
		// "ab%d" -> sanitized "abd" (3 chars) -> below min length -> none.
		expect(res.status).toBe("none");
	});

	it("excludes archived (closed) tabs from matches", () => {
		createTab("abcd1234-0000-4000-8000-000000000000", "Alpha");
		archiveTab("abcd1234-0000-4000-8000-000000000000");
		expect(resolveTabPrefix("abcd").status).toBe("none");
	});
});

// ---------------------------------------------------------------------------
// shortestUniquePrefix — display-handle derivation
// ---------------------------------------------------------------------------
describe("shortestUniquePrefix", () => {
	it("returns a 4-char prefix when no other open tab collides", () => {
		createTab("abcd1234-0000-4000-8000-000000000000", "Alpha");
		expect(shortestUniquePrefix("abcd1234-0000-4000-8000-000000000000")).toBe("abcd");
	});

	it("grows the prefix one char at a time on a collision", () => {
		createTab("abcd1111-0000-4000-8000-000000000000", "One");
		createTab("abcd2222-0000-4000-8000-000000000000", "Two");
		// First differing char is at index 4, so a 5-char prefix is unique.
		expect(shortestUniquePrefix("abcd1111-0000-4000-8000-000000000000")).toBe("abcd1");
		expect(shortestUniquePrefix("abcd2222-0000-4000-8000-000000000000")).toBe("abcd2");
	});

	it("ignores closed tabs when computing uniqueness", () => {
		createTab("abcd1111-0000-4000-8000-000000000000", "One");
		createTab("abcd2222-0000-4000-8000-000000000000", "Two");
		archiveTab("abcd2222-0000-4000-8000-000000000000");
		// With Two closed, One no longer collides → back to 4 chars.
		expect(shortestUniquePrefix("abcd1111-0000-4000-8000-000000000000")).toBe("abcd");
	});
});

// ---------------------------------------------------------------------------
// updateTabPositions — drag-and-drop reorder persistence
// ---------------------------------------------------------------------------
describe("updateTabPositions", () => {
	it("rewrites each tab's position to its index in the given order", () => {
		createTab("a", "A"); // position 0
		createTab("b", "B"); // position 1
		createTab("c", "C"); // position 2

		updateTabPositions(["c", "a", "b"]);

		// listOpenTabs orders by position → reflects the new order.
		expect(listOpenTabs().map((t) => t.id)).toEqual(["c", "a", "b"]);
		expect(getTab("c")?.position).toBe(0);
		expect(getTab("a")?.position).toBe(1);
		expect(getTab("b")?.position).toBe(2);
	});

	it("is a no-op for an empty list", () => {
		createTab("a", "A");
		createTab("b", "B");
		updateTabPositions([]);
		expect(listOpenTabs().map((t) => t.id)).toEqual(["a", "b"]);
	});

	it("ignores ids that don't exist without throwing", () => {
		createTab("a", "A");
		expect(() => updateTabPositions(["ghost", "a"])).not.toThrow();
		// "a" took index 1 in the requested order.
		expect(getTab("a")?.position).toBe(1);
	});
});
