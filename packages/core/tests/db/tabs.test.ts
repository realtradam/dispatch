import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory database instance assigned in beforeAll. */
let memDb: Database;

// Mock getDatabase to return the in-memory database.  The factory
// captures memDb by reference — it won't be dereferenced until a test
// calls getDescendantIds (or another exported function), by which
// point beforeAll will have initialised the variable.
vi.mock("../../src/db/index.js", () => ({
	getDatabase: vi.fn(() => memDb),
}));

// Dynamic import AFTER the mock is registered (hoisted) so the
// module-under-test sees the mocked getDatabase.
const {
	getDescendantIds,
	createTab,
	archiveTab,
	getTab,
} = await import("../../src/db/tabs.js");

beforeAll(() => {
	memDb = new Database(":memory:");
	memDb.run(`CREATE TABLE tabs (
		id             TEXT PRIMARY KEY,
		title          TEXT NOT NULL,
		key_id         TEXT,
		model_id       TEXT,
		parent_tab_id  TEXT,
		status         TEXT NOT NULL DEFAULT 'idle',
		is_open        INTEGER NOT NULL DEFAULT 1,
		position       INTEGER NOT NULL DEFAULT 0,
		created_at     INTEGER NOT NULL,
		updated_at     INTEGER NOT NULL
	)`);
});

afterAll(() => {
	memDb.close();
});

/** Wipe the tabs table between tests so every test starts clean. */
beforeEach(() => {
	memDb.run("DELETE FROM tabs");
});

// ---------------------------------------------------------------------------
// getDescendantIds
// ---------------------------------------------------------------------------
describe("getDescendantIds", () => {
	it("returns only the id when the tab has no children", () => {
		const now = Date.now();
		memDb.run(
			`INSERT INTO tabs (id, title, status, is_open, position, created_at, updated_at)
			 VALUES ('root', 'Root', 'idle', 1, 0, $now, $now)`,
			{ $now: now },
		);

		const ids = getDescendantIds("root");
		expect(ids).toEqual(["root"]);
	});

	it("returns leaf-first order for a linear chain (root → child → grandchild)", () => {
		const now = Date.now();
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('root', 'Root', NULL, 'idle', 1, 0, $now, $now)`,
			{ $now: now },
		);
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('child', 'Child', 'root', 'idle', 1, 1, $now, $now)`,
			{ $now: now },
		);
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('grandchild', 'Grandchild', 'child', 'idle', 1, 2, $now, $now)`,
			{ $now: now },
		);

		const ids = getDescendantIds("root");
		// Leaves first: grandchild, child, root
		expect(ids).toEqual(["grandchild", "child", "root"]);
	});

	it("returns leaf-first for a branching tree", () => {
		const now = Date.now();
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('a', 'A', NULL, 'idle', 1, 0, $now, $now)`,
			{ $now: now },
		);
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('b1', 'B1', 'a', 'idle', 1, 1, $now, $now)`,
			{ $now: now },
		);
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('b2', 'B2', 'a', 'idle', 1, 2, $now, $now)`,
			{ $now: now },
		);
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('c1', 'C1', 'b1', 'idle', 1, 3, $now, $now)`,
			{ $now: now },
		);
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('c2', 'C2', 'b1', 'idle', 1, 4, $now, $now)`,
			{ $now: now },
		);

		const ids = getDescendantIds("a");
		// BFS: a, b1, b2, c1, c2  →  reverse: c2, c1, b2, b1, a
		expect(ids).toEqual(["c2", "c1", "b2", "b1", "a"]);
	});

	it("skips archived descendants (is_open = 0)", () => {
		const now = Date.now();
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('root', 'Root', NULL, 'idle', 1, 0, $now, $now)`,
			{ $now: now },
		);
		// Open child of root — should appear
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('open-child', 'Open', 'root', 'idle', 1, 1, $now, $now)`,
			{ $now: now },
		);
		// Archived child — should be skipped together with its descendants
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('archived-child', 'Archived', 'root', 'idle', 0, 2, $now, $now)`,
			{ $now: now },
		);
		// Child of archived — data drift, should NOT appear
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('orphan', 'Orphan', 'archived-child', 'idle', 1, 3, $now, $now)`,
			{ $now: now },
		);

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
		const now = Date.now();
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('x', 'X', 'y', 'idle', 1, 0, $now, $now)`,
			{ $now: now },
		);
		memDb.run(
			`INSERT INTO tabs (id, title, parent_tab_id, status, is_open, position, created_at, updated_at)
			 VALUES ('y', 'Y', 'x', 'idle', 1, 1, $now, $now)`,
			{ $now: now },
		);

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
