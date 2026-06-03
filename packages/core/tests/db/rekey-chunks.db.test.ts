import { beforeEach, describe, expect, it, vi } from "vitest";

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
 * Minimal in-memory fake of bun:sqlite supporting only the queries
 * `appendChunks`, `getChunksForTab`, and `rekeyChunks` issue. Mirrors the
 * approach in chunks.db.test.ts (exact normalized-string branches).
 */
class FakeDatabase {
	rows: ChunkRecord[] = [];

	query(sql: string) {
		return {
			all: (params?: Record<string, unknown>) => this.execSelect(sql, params),
			get: (params?: Record<string, unknown>) => this.execSelect(sql, params)[0] ?? null,
			run: (params?: Record<string, unknown>) => this.execMutation(sql, params),
		};
	}

	transaction(fn: () => void): () => void {
		return () => fn();
	}

	private execSelect(sql: string, params?: Record<string, unknown>): unknown[] {
		const norm = sql.replace(/\s+/g, " ").trim();
		const tabId = params?.$tabId as string | undefined;
		const forTab = this.rows.filter((r) => r.tab_id === tabId);
		const visible = forTab.filter((r) => r.type !== "usage");

		if (norm === "SELECT COALESCE(MAX(seq), -1) as max_seq FROM chunks WHERE tab_id = $tabId") {
			const seqs = forTab.map((r) => r.seq);
			return [{ max_seq: seqs.length > 0 ? Math.max(...seqs) : -1 }];
		}
		if (
			norm === "SELECT * FROM chunks WHERE tab_id = $tabId AND type != 'usage' ORDER BY seq ASC"
		) {
			return [...visible].sort((a, b) => a.seq - b.seq);
		}
		throw new Error(`FakeDatabase: unsupported SELECT: ${norm}`);
	}

	private execMutation(sql: string, params?: Record<string, unknown>): { changes: number } {
		const norm = sql.replace(/\s+/g, " ").trim();
		if (
			norm ===
			"INSERT INTO chunks (id, tab_id, seq, turn_id, step, role, type, data_json, created_at) VALUES ($id, $tabId, $seq, $turnId, $step, $role, $type, $dataJson, $now)"
		) {
			this.rows.push({
				id: params?.$id as string,
				tab_id: params?.$tabId as string,
				seq: params?.$seq as number,
				turn_id: params?.$turnId as string,
				step: (params?.$step as number) ?? 0,
				role: params?.$role as string,
				type: params?.$type as string,
				data_json: params?.$dataJson as string,
				created_at: (params?.$now as number) ?? 0,
			});
			return { changes: 1 };
		}
		if (norm === "UPDATE chunks SET tab_id = $to WHERE tab_id = $from") {
			const from = params?.$from as string;
			const to = params?.$to as string;
			let changes = 0;
			for (const r of this.rows) {
				if (r.tab_id === from) {
					r.tab_id = to;
					changes++;
				}
			}
			return { changes };
		}
		throw new Error(`FakeDatabase: unsupported mutation: ${norm}`);
	}
}

let fakeDb: FakeDatabase;
vi.mock("../../src/db/index.js", () => ({ getDatabase: vi.fn(() => fakeDb) }));

const { appendChunks, getChunksForTab, rekeyChunks } = await import("../../src/db/chunks.js");

beforeEach(() => {
	fakeDb = new FakeDatabase();
});

describe("rekeyChunks", () => {
	it("relocates all rows from one tab to another and reports the count", () => {
		appendChunks("src", [
			{ turnId: "t1", step: 0, role: "user", type: "text", data: { text: "hi" } },
			{ turnId: "t1", step: 0, role: "assistant", type: "text", data: { text: "yo" } },
		]);
		expect(getChunksForTab("src")).toHaveLength(2);

		const moved = rekeyChunks("src", "backup");
		expect(moved).toBe(2);
		expect(getChunksForTab("src")).toHaveLength(0);
		const dst = getChunksForTab("backup");
		expect(dst).toHaveLength(2);
		// turn id + seq preserved on the destination
		expect(dst.map((r) => r.turnId)).toEqual(["t1", "t1"]);
		expect(dst.map((r) => r.seq)).toEqual([0, 1]);
	});

	it("returns 0 when the source tab has no rows", () => {
		expect(rekeyChunks("nope", "backup")).toBe(0);
	});

	it("does not touch unrelated tabs", () => {
		appendChunks("src", [
			{ turnId: "t1", step: 0, role: "user", type: "text", data: { text: "a" } },
		]);
		appendChunks("other", [
			{ turnId: "t9", step: 0, role: "user", type: "text", data: { text: "b" } },
		]);
		rekeyChunks("src", "backup");
		expect(getChunksForTab("other")).toHaveLength(1);
	});
});
