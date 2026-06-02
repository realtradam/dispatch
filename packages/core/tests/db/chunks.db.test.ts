import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkRowDraft, UsageData } from "../../src/types/index.js";

/**
 * Internal row shape — matches the production `chunks` table columns.
 * Kept loose at the `query()` boundary to mirror bun:sqlite's dynamic
 * return type.
 */
interface ChunkRecord {
	id: string;
	tab_id: string;
	seq: number;
	turn_id: string;
	step: number;
	role: string;
	type: string;
	data_json: string;
	created_at: number;
}

/**
 * In-memory fake of `bun:sqlite`'s Database implementing only the queries
 * `chunks.ts` actually issues. Same approach as `tabs.test.ts`: match exact
 * normalized query strings as fixed branches (no SQL parser), so a query-string
 * change fails loudly as "unsupported" instead of silently returning wrong data.
 *
 * This lets the DB-backed `getChunksForTab` / `getTotalChunkCount` /
 * `getUsageStatsForTab` logic run under vitest, where `bun:sqlite` can't load.
 */
class FakeDatabase {
	rows: ChunkRecord[] = [];
	private idCounter = 0;

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

	/** bun:sqlite's `db.transaction(fn)` returns a callable that runs `fn`. */
	transaction(fn: () => void): () => void {
		return () => {
			fn();
		};
	}

	private execSelect(sql: string, params?: Record<string, unknown>): unknown[] {
		const norm = sql.replace(/\s+/g, " ").trim();
		const tabId = params?.$tabId as string | undefined;
		const forTab = this.rows.filter((r) => r.tab_id === tabId);
		const visible = forTab.filter((r) => r.type !== "usage");

		// appendChunks: next-seq lookup (counts ALL rows, incl. usage)
		if (norm === "SELECT COALESCE(MAX(seq), -1) as max_seq FROM chunks WHERE tab_id = $tabId") {
			const seqs = forTab.map((r) => r.seq);
			return [{ max_seq: seqs.length > 0 ? Math.max(...seqs) : -1 }];
		}

		// getChunksForTab — no options (usage excluded)
		if (
			norm === "SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' ORDER BY seq ASC"
		) {
			return [...visible].sort((a, b) => a.seq - b.seq);
		}

		// getChunksForTab — before + limit (usage excluded)
		if (
			norm ===
			"SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' AND seq < $before ORDER BY seq DESC LIMIT $limit"
		) {
			const before = params?.$before as number;
			const limit = params?.$limit as number;
			return visible
				.filter((r) => r.seq < before)
				.sort((a, b) => b.seq - a.seq)
				.slice(0, limit);
		}

		// getChunksForTab — before only (usage excluded)
		if (
			norm ===
			"SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' AND seq < $before ORDER BY seq DESC"
		) {
			const before = params?.$before as number;
			return visible.filter((r) => r.seq < before).sort((a, b) => b.seq - a.seq);
		}

		// getChunksForTab — limit only (usage excluded)
		if (
			norm ===
			"SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' ORDER BY seq DESC LIMIT $limit"
		) {
			const limit = params?.$limit as number;
			return [...visible].sort((a, b) => b.seq - a.seq).slice(0, limit);
		}

		// getTotalChunkCount (usage excluded)
		if (norm === "SELECT COUNT(*) as count FROM chunks WHERE tab_id = $tabId AND type != 'usage'") {
			return [{ count: visible.length }];
		}

		// getUsageStatsForTab: usage rows only, in seq order
		if (
			norm ===
			"SELECT data_json FROM chunks WHERE tab_id = $tabId AND type = 'usage' ORDER BY seq ASC"
		) {
			return forTab
				.filter((r) => r.type === "usage")
				.sort((a, b) => a.seq - b.seq)
				.map((r) => ({ data_json: r.data_json }));
		}

		throw new Error(`FakeDatabase: unsupported SELECT: ${norm}`);
	}

	private execMutation(sql: string, params?: Record<string, unknown>): void {
		const norm = sql.replace(/\s+/g, " ").trim();

		// appendChunks: single-row insert
		if (
			norm ===
			"INSERT INTO chunks (id, tab_id, seq, turn_id, step, role, type, data_json, created_at) VALUES ($id, $tabId, $seq, $turnId, $step, $role, $type, $dataJson, $now)"
		) {
			this.rows.push({
				id: (params?.$id as string) ?? `c${this.idCounter++}`,
				tab_id: params?.$tabId as string,
				seq: params?.$seq as number,
				turn_id: params?.$turnId as string,
				step: (params?.$step as number) ?? 0,
				role: params?.$role as string,
				type: params?.$type as string,
				data_json: params?.$dataJson as string,
				created_at: (params?.$now as number) ?? 0,
			});
			return;
		}

		throw new Error(`FakeDatabase: unsupported mutation: ${norm}`);
	}
}

let fakeDb: FakeDatabase;

vi.mock("../../src/db/index.js", () => ({
	getDatabase: vi.fn(() => fakeDb),
}));

const { appendChunks, getChunksForTab, getTotalChunkCount, getUsageStatsForTab } = await import(
	"../../src/db/chunks.js"
);

function usageDraft(turnId: string, u: UsageData): ChunkRowDraft {
	return { turnId, step: 0, role: "assistant", type: "usage", data: u };
}

beforeAll(() => {
	fakeDb = new FakeDatabase();
});

beforeEach(() => {
	fakeDb.rows = [];
});

// ---------------------------------------------------------------------------
// usage chunk persistence + side-channel invariants
// ---------------------------------------------------------------------------
describe("usage chunk rows (DB-backed)", () => {
	const TAB = "tab-usage";

	it("persists usage rows alongside content rows with contiguous seqs", () => {
		appendChunks(TAB, [
			{ turnId: "t1", step: 0, role: "user", type: "text", data: { text: "hi" } },
			{ turnId: "t1", step: 0, role: "assistant", type: "text", data: { text: "yo" } },
			usageDraft("t1", {
				inputTokens: 100,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 90,
			}),
		]);
		// All three rows landed with contiguous seqs.
		expect(fakeDb.rows.map((r) => r.seq)).toEqual([0, 1, 2]);
		expect(fakeDb.rows.map((r) => r.type)).toEqual(["text", "text", "usage"]);
	});

	it("excludes usage rows from getChunksForTab (all variants)", () => {
		appendChunks(TAB, [
			{ turnId: "t1", step: 0, role: "user", type: "text", data: { text: "q" } },
			usageDraft("t1", {
				inputTokens: 100,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 90,
			}),
			{ turnId: "t1", step: 0, role: "assistant", type: "text", data: { text: "a" } },
			usageDraft("t1", {
				inputTokens: 200,
				outputTokens: 20,
				cacheReadTokens: 150,
				cacheWriteTokens: 0,
			}),
		]);

		// no options
		const all = getChunksForTab(TAB);
		expect(all.every((r) => r.type !== "usage")).toBe(true);
		expect(all.map((r) => r.type)).toEqual(["text", "text"]);

		// limit only
		const limited = getChunksForTab(TAB, { limit: 10 });
		expect(limited.every((r) => r.type !== "usage")).toBe(true);
		expect(limited).toHaveLength(2);

		// before only — `before` is a seq cursor; usage seqs must never surface
		const before = getChunksForTab(TAB, { before: 100 });
		expect(before.every((r) => r.type !== "usage")).toBe(true);
		expect(before).toHaveLength(2);

		// before + limit
		const bl = getChunksForTab(TAB, { before: 100, limit: 10 });
		expect(bl.every((r) => r.type !== "usage")).toBe(true);
		expect(bl).toHaveLength(2);
	});

	it("excludes usage rows from getTotalChunkCount", () => {
		appendChunks(TAB, [
			{ turnId: "t1", step: 0, role: "user", type: "text", data: { text: "q" } },
			{ turnId: "t1", step: 0, role: "assistant", type: "text", data: { text: "a" } },
			usageDraft("t1", {
				inputTokens: 100,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 90,
			}),
		]);
		// 3 rows total, but only 2 visible.
		expect(getTotalChunkCount(TAB)).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// getUsageStatsForTab — backend aggregate
// ---------------------------------------------------------------------------
describe("getUsageStatsForTab", () => {
	const TAB = "tab-agg";

	it("returns null when the tab has no usage rows", () => {
		appendChunks(TAB, [
			{ turnId: "t1", step: 0, role: "assistant", type: "text", data: { text: "a" } },
		]);
		expect(getUsageStatsForTab(TAB)).toBeNull();
	});

	it("sums cumulative tokens, counts requests, and reports the last request's split", () => {
		appendChunks(TAB, [
			usageDraft("t1", {
				inputTokens: 1000,
				outputTokens: 40,
				cacheReadTokens: 0,
				cacheWriteTokens: 900,
			}),
			usageDraft("t1", {
				inputTokens: 1200,
				outputTokens: 60,
				cacheReadTokens: 1000,
				cacheWriteTokens: 100,
			}),
		]);

		const stats = getUsageStatsForTab(TAB);
		expect(stats).not.toBeNull();
		expect(stats?.requests).toBe(2);
		expect(stats?.inputTokens).toBe(2200);
		expect(stats?.outputTokens).toBe(100);
		expect(stats?.cacheReadTokens).toBe(1000);
		expect(stats?.cacheWriteTokens).toBe(1000);
		// `last` = the most recent (highest-seq) usage row.
		expect(stats?.last).toEqual({
			inputTokens: 1200,
			outputTokens: 60,
			cacheReadTokens: 1000,
			cacheWriteTokens: 100,
		});
	});

	it("is structurally identical to the frontend CacheStats shape (seeds directly)", () => {
		appendChunks(TAB, [
			usageDraft("t1", {
				inputTokens: 5,
				outputTokens: 1,
				cacheReadTokens: 2,
				cacheWriteTokens: 3,
			}),
		]);
		const stats = getUsageStatsForTab(TAB);
		expect(Object.keys(stats ?? {}).sort()).toEqual(
			[
				"cacheReadTokens",
				"cacheWriteTokens",
				"inputTokens",
				"last",
				"outputTokens",
				"requests",
			].sort(),
		);
	});

	it("is scoped per tab", () => {
		appendChunks("tab-a", [
			usageDraft("t1", {
				inputTokens: 10,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
		]);
		appendChunks("tab-b", [
			usageDraft("t2", {
				inputTokens: 20,
				outputTokens: 2,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
		]);
		expect(getUsageStatsForTab("tab-a")?.inputTokens).toBe(10);
		expect(getUsageStatsForTab("tab-b")?.inputTokens).toBe(20);
	});
});
