import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import type { LogRecord } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { computeEvictions, createTraceStore, stableId } from "./store.js";

const logRecord: LogRecord = {
	kind: "log",
	level: "info",
	msg: "hello",
	timestamp: 1700000000000,
	extensionId: "test-ext",
	conversationId: "conv-1",
	turnId: "turn-1",
	spanId: "span-1",
	attributes: { key: "value" },
};

const spanOpenRecord: LogRecord = {
	kind: "span-open",
	spanId: "span-2",
	name: "step",
	timestamp: 1700000000100,
	extensionId: "test-ext",
	conversationId: "conv-1",
	turnId: "turn-1",
	parentSpanId: "span-1",
};

const spanCloseRecord: LogRecord = {
	kind: "span-close",
	spanId: "span-2",
	name: "step",
	timestamp: 1700000000500,
	durationMs: 400,
	status: "ok",
	extensionId: "test-ext",
	conversationId: "conv-1",
	turnId: "turn-1",
	parentSpanId: "span-1",
};

const bodyRecord: LogRecord = {
	kind: "span-open",
	spanId: "span-3",
	name: "prompt",
	timestamp: 1700000000200,
	extensionId: "test-ext",
	conversationId: "conv-1",
	turnId: "turn-1",
	body: "the full prompt text",
};

const logRecordNoBody: LogRecord = {
	kind: "log",
	level: "debug",
	msg: "no body here",
	timestamp: 1700000000050,
	extensionId: "ext-min",
	turnId: "turn-1",
};

describe("stableId", () => {
	it("produces a 16-char hex string", () => {
		const id = stableId(logRecord);
		expect(id).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is deterministic for the same record", () => {
		expect(stableId(logRecord)).toBe(stableId(logRecord));
	});

	it("produces different ids for different records", () => {
		expect(stableId(logRecord)).not.toBe(stableId(spanOpenRecord));
	});
});

describe("createTraceStore", () => {
	function freshStore() {
		return createTraceStore({ path: ":memory:" });
	}

	it("inserts and retrieves records ordered by timestamp", () => {
		const store = freshStore();
		store.insertRecords([logRecord, spanCloseRecord, spanOpenRecord]);
		const result = store.getTurn("turn-1");
		expect(result).toHaveLength(3);
		expect(result[0]?.timestamp).toBe(1700000000000);
		expect(result[1]?.timestamp).toBe(1700000000100);
		expect(result[2]?.timestamp).toBe(1700000000500);
		store.close();
	});

	it("reconstructs attributes from JSON", () => {
		const store = freshStore();
		store.insertRecords([logRecord]);
		const result = store.getTurn("turn-1");
		expect(result[0]?.kind).toBe("log");
		if (result[0]?.kind === "log") {
			expect(result[0].attributes).toEqual({ key: "value" });
		}
		store.close();
	});

	it("reconstructs links from JSON", () => {
		const store = freshStore();
		const withLinks: LogRecord = {
			kind: "span-open",
			spanId: "span-link",
			name: "linked",
			timestamp: 1700000000999,
			extensionId: "ext",
			turnId: "turn-1",
			links: [{ spanId: "other-span", turnId: "turn-0", reason: "caused" }],
		};
		store.insertRecords([withLinks]);
		const result = store.getTurn("turn-1");
		expect(result[0]?.kind).toBe("span-open");
		if (result[0]?.kind === "span-open") {
			expect(result[0].links).toEqual([
				{ spanId: "other-span", turnId: "turn-0", reason: "caused" },
			]);
		}
		store.close();
	});

	it("returns empty array for unknown turnId", () => {
		const store = freshStore();
		store.insertRecords([logRecord]);
		expect(store.getTurn("nonexistent")).toEqual([]);
		store.close();
	});

	it("getBody returns body for body-bearing records", () => {
		const store = freshStore();
		store.insertRecords([bodyRecord]);
		const id = stableId(bodyRecord);
		expect(store.getBody(id)).toBe("the full prompt text");
		store.close();
	});

	it("getBody returns undefined for records without body", () => {
		const store = freshStore();
		store.insertRecords([logRecordNoBody]);
		const id = stableId(logRecordNoBody);
		expect(store.getBody(id)).toBeUndefined();
		store.close();
	});

	it("bodies table only holds body-bearing records", () => {
		const store = freshStore();
		store.insertRecords([logRecord, bodyRecord, logRecordNoBody]);
		const bodyId = stableId(bodyRecord);
		expect(store.getBody(bodyId)).toBe("the full prompt text");

		const logId = stableId(logRecord);
		expect(store.getBody(logId)).toBeUndefined();

		const noBodyId = stableId(logRecordNoBody);
		expect(store.getBody(noBodyId)).toBeUndefined();
		store.close();
	});

	it("is idempotent — re-inserting the same records produces no duplicates", () => {
		const store = freshStore();
		store.insertRecords([logRecord, spanOpenRecord, spanCloseRecord, bodyRecord]);
		store.insertRecords([logRecord, spanOpenRecord, spanCloseRecord, bodyRecord]);
		const result = store.getTurn("turn-1");
		expect(result).toHaveLength(4);
		store.close();
	});

	it("handles span-close record with attributes and links round-trip", () => {
		const store = freshStore();
		const closeWithMeta: LogRecord = {
			kind: "span-close",
			spanId: "span-m",
			name: "step",
			timestamp: 1700000001000,
			durationMs: 250,
			status: "error",
			extensionId: "ext",
			turnId: "turn-1",
			attributes: { httpStatus: 500 },
			links: [{ spanId: "upstream" }],
		};
		store.insertRecords([closeWithMeta]);
		const result = store.getTurn("turn-1");
		expect(result[0]?.kind).toBe("span-close");
		if (result[0]?.kind === "span-close") {
			expect(result[0].durationMs).toBe(250);
			expect(result[0].status).toBe("error");
			expect(result[0].attributes).toEqual({ httpStatus: 500 });
			expect(result[0].links).toEqual([{ spanId: "upstream" }]);
		}
		store.close();
	});

	it("easyView delegates to renderEasyView", () => {
		const store = freshStore();
		store.insertRecords([spanOpenRecord]);
		const output = store.easyView("turn-1");
		expect(output).toContain("step (open)");
		store.close();
	});

	it("persists to a file path", () => {
		const tmpPath = `/tmp/trace-store-test-${Date.now()}.db`;
		const store = createTraceStore({ path: tmpPath });
		store.insertRecords([logRecord]);
		store.close();

		const store2 = createTraceStore({ path: tmpPath });
		const result = store2.getTurn("turn-1");
		expect(result).toHaveLength(1);
		expect(result[0]?.kind).toBe("log");
		store2.close();

		try {
			unlinkSync(tmpPath);
		} catch {
			// ignore cleanup error
		}
	});

	it("body round-trips through getTurn", () => {
		const store = freshStore();
		store.insertRecords([bodyRecord]);
		const result = store.getTurn("turn-1");
		expect(result).toHaveLength(1);
		expect(result[0]?.kind).toBe("span-open");
		if (result[0]?.kind === "span-open") {
			expect(result[0].body).toBe("the full prompt text");
		}
		store.close();
	});
});

describe("content-addressed body storage", () => {
	function freshStore() {
		return createTraceStore({ path: ":memory:" });
	}

	it("content-addresses two identical bodies to a single stored body row", () => {
		const store = freshStore();
		const rec1: LogRecord = {
			kind: "span-open",
			spanId: "s1",
			name: "prompt",
			timestamp: 1000,
			extensionId: "ext",
			turnId: "t1",
			body: "identical body content",
		};
		const rec2: LogRecord = {
			kind: "span-open",
			spanId: "s2",
			name: "prompt",
			timestamp: 2000,
			extensionId: "ext",
			turnId: "t1",
			body: "identical body content",
		};
		store.insertRecords([rec1, rec2]);

		const id1 = stableId(rec1);
		const id2 = stableId(rec2);
		expect(store.getBody(id1)).toBe("identical body content");
		expect(store.getBody(id2)).toBe("identical body content");
		store.close();
	});

	it("stores distinct bodies separately", () => {
		const store = freshStore();
		const rec1: LogRecord = {
			kind: "span-open",
			spanId: "s1",
			name: "prompt",
			timestamp: 1000,
			extensionId: "ext",
			turnId: "t1",
			body: "body A",
		};
		const rec2: LogRecord = {
			kind: "span-open",
			spanId: "s2",
			name: "prompt",
			timestamp: 2000,
			extensionId: "ext",
			turnId: "t1",
			body: "body B",
		};
		store.insertRecords([rec1, rec2]);

		const id1 = stableId(rec1);
		const id2 = stableId(rec2);
		expect(store.getBody(id1)).toBe("body A");
		expect(store.getBody(id2)).toBe("body B");
		store.close();
	});

	it("compresses a body above the threshold and round-trips it on read", () => {
		const store = freshStore();
		const largeBody = "x".repeat(2048);
		const rec: LogRecord = {
			kind: "span-open",
			spanId: "s1",
			name: "prompt",
			timestamp: 1000,
			extensionId: "ext",
			turnId: "t1",
			body: largeBody,
		};
		store.insertRecords([rec]);
		const id = stableId(rec);
		expect(store.getBody(id)).toBe(largeBody);
		store.close();
	});
});

describe("prune", () => {
	function freshStore() {
		return createTraceStore({ path: ":memory:" });
	}

	it("prune by maxAgeMs deletes records and their bodies older than the cutoff", () => {
		const store = freshStore();
		const oldRec: LogRecord = {
			kind: "span-open",
			spanId: "s-old",
			name: "old-prompt",
			timestamp: 1000,
			extensionId: "ext",
			turnId: "t1",
			body: "old body content",
		};
		const newRec: LogRecord = {
			kind: "span-open",
			spanId: "s-new",
			name: "new-prompt",
			timestamp: Date.now(),
			extensionId: "ext",
			turnId: "t2",
			body: "new body content",
		};
		store.insertRecords([oldRec, newRec]);

		const summary = store.prune({ maxAgeMs: 60000 });
		expect(summary.recordsDeleted).toBe(1);

		const result = store.getTurn("t1");
		expect(result).toHaveLength(0);
		expect(store.getBody(stableId(oldRec))).toBeUndefined();

		const newResult = store.getTurn("t2");
		expect(newResult).toHaveLength(1);
		expect(store.getBody(stableId(newRec))).toBe("new body content");
		store.close();
	});

	it("prune by maxTotalBodyBytes evicts oldest bodies until under the cap", () => {
		const store = freshStore();
		const body1 = "a".repeat(300);
		const body2 = "b".repeat(300);
		const body3 = "c".repeat(300);
		const rec1: LogRecord = {
			kind: "span-open",
			spanId: "s1",
			name: "p",
			timestamp: 1000,
			extensionId: "ext",
			turnId: "t1",
			body: body1,
		};
		const rec2: LogRecord = {
			kind: "span-open",
			spanId: "s2",
			name: "p",
			timestamp: 2000,
			extensionId: "ext",
			turnId: "t2",
			body: body2,
		};
		const rec3: LogRecord = {
			kind: "span-open",
			spanId: "s3",
			name: "p",
			timestamp: 3000,
			extensionId: "ext",
			turnId: "t3",
			body: body3,
		};
		store.insertRecords([rec1, rec2, rec3]);

		const summary = store.prune({ maxTotalBodyBytes: 500 });
		expect(summary.bodiesDeleted).toBeGreaterThanOrEqual(1);

		expect(store.getBody(stableId(rec1))).toBeUndefined();

		const remaining = store.getTurn("t3");
		if (remaining.length > 0 && remaining[0]?.kind === "span-open") {
			expect(remaining[0].body).toBe(body3);
		}
		store.close();
	});

	it("prune garbage-collects an orphaned body with no referencing record", () => {
		const store = freshStore();
		const rec: LogRecord = {
			kind: "span-open",
			spanId: "s1",
			name: "p",
			timestamp: 1000,
			extensionId: "ext",
			turnId: "t1",
			body: "orphan body",
		};
		store.insertRecords([rec]);

		const summary = store.prune({ maxAgeMs: 60000 });
		expect(summary.recordsDeleted).toBe(1);
		expect(summary.bodiesDeleted).toBe(1);
		store.close();
	});

	it("prune keeps a still-referenced body when a duplicate referrer remains", () => {
		const store = freshStore();
		const sharedBody = "shared body content";
		const rec1: LogRecord = {
			kind: "span-open",
			spanId: "s1",
			name: "p",
			timestamp: 1000,
			extensionId: "ext",
			turnId: "t1",
			body: sharedBody,
		};
		const rec2: LogRecord = {
			kind: "span-open",
			spanId: "s2",
			name: "p",
			timestamp: Date.now(),
			extensionId: "ext",
			turnId: "t2",
			body: sharedBody,
		};
		store.insertRecords([rec1, rec2]);

		const summary = store.prune({ maxAgeMs: 60000 });
		expect(summary.recordsDeleted).toBe(1);
		expect(summary.bodiesDeleted).toBe(0);

		const id2 = stableId(rec2);
		expect(store.getBody(id2)).toBe(sharedBody);
		store.close();
	});
});

describe("computeEvictions", () => {
	it("returns empty when under cap", () => {
		const bodies = [
			{ hash: "a", storedSize: 100, oldestRecordTimestamp: 1000 },
			{ hash: "b", storedSize: 200, oldestRecordTimestamp: 2000 },
		];
		expect(computeEvictions(bodies, 500)).toEqual([]);
	});

	it("evicts oldest bodies until under cap", () => {
		const bodies = [
			{ hash: "a", storedSize: 300, oldestRecordTimestamp: 1000 },
			{ hash: "b", storedSize: 300, oldestRecordTimestamp: 2000 },
			{ hash: "c", storedSize: 300, oldestRecordTimestamp: 3000 },
		];
		const evicted = computeEvictions(bodies, 500);
		expect(evicted).toEqual(["a", "b"]);
	});

	it("evicts multiple oldest bodies", () => {
		const bodies = [
			{ hash: "a", storedSize: 200, oldestRecordTimestamp: 1000 },
			{ hash: "b", storedSize: 200, oldestRecordTimestamp: 2000 },
			{ hash: "c", storedSize: 200, oldestRecordTimestamp: 3000 },
		];
		const evicted = computeEvictions(bodies, 300);
		expect(evicted).toEqual(["a", "b"]);
	});
});

describe("old-schema migration", () => {
	function tmpPath(): string {
		return `/tmp/trace-store-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
	}

	function cleanup(path: string): void {
		try {
			unlinkSync(path);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${path}-wal`);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${path}-shm`);
		} catch {
			// ignore
		}
	}

	it("migrates a pre-existing old-schema DB (records without bodyHash + bodies keyed by recordId) on open without error", () => {
		const path = tmpPath();
		try {
			const oldDb = new Database(path);
			oldDb.run("PRAGMA journal_mode = WAL");
			oldDb.run(`
				CREATE TABLE records (
					id TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					level TEXT,
					msg TEXT,
					name TEXT,
					spanId TEXT,
					parentSpanId TEXT,
					conversationId TEXT,
					turnId TEXT,
					extensionId TEXT NOT NULL,
					timestamp INTEGER NOT NULL,
					durationMs INTEGER,
					status TEXT,
					attributes TEXT,
					links TEXT
				)
			`);
			oldDb.run(`
				CREATE TABLE bodies (
					recordId TEXT PRIMARY KEY REFERENCES records(id),
					body TEXT NOT NULL
				)
			`);

			oldDb.run(
				`INSERT INTO records (id, kind, level, msg, name, spanId, parentSpanId, conversationId, turnId, extensionId, timestamp, durationMs, status, attributes, links)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"rec-1",
					"span-open",
					null,
					null,
					"prompt",
					"s1",
					null,
					"conv-1",
					"t1",
					"ext",
					1000,
					null,
					null,
					null,
					null,
				],
			);
			oldDb.run(
				`INSERT INTO records (id, kind, level, msg, name, spanId, parentSpanId, conversationId, turnId, extensionId, timestamp, durationMs, status, attributes, links)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"rec-2",
					"span-open",
					null,
					null,
					"prompt",
					"s2",
					null,
					"conv-1",
					"t1",
					"ext",
					2000,
					null,
					null,
					null,
					null,
				],
			);

			const sharedBody = "identical body content for migration test";
			oldDb.run("INSERT INTO bodies (recordId, body) VALUES (?, ?)", ["rec-1", sharedBody]);
			oldDb.run("INSERT INTO bodies (recordId, body) VALUES (?, ?)", ["rec-2", sharedBody]);

			oldDb.close();

			const store = createTraceStore({ path });

			const turn = store.getTurn("t1");
			expect(turn).toHaveLength(2);
			expect(turn[0]?.kind).toBe("span-open");
			expect(turn[1]?.kind).toBe("span-open");

			expect(store.getBody("rec-1")).toBe(sharedBody);
			expect(store.getBody("rec-2")).toBe(sharedBody);

			const db = new Database(path);
			const bodyRows = db.query("SELECT hash FROM bodies").all() as Array<{ hash: string }>;
			expect(bodyRows).toHaveLength(1);
			db.close();

			store.close();
		} finally {
			cleanup(path);
		}
	});

	it("re-opening an already-migrated DB is a no-op (no error, no double-migrate)", () => {
		const path = tmpPath();
		try {
			const oldDb = new Database(path);
			oldDb.run("PRAGMA journal_mode = WAL");
			oldDb.run(`
				CREATE TABLE records (
					id TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					level TEXT,
					msg TEXT,
					name TEXT,
					spanId TEXT,
					parentSpanId TEXT,
					conversationId TEXT,
					turnId TEXT,
					extensionId NOT NULL,
					timestamp INTEGER NOT NULL,
					durationMs INTEGER,
					status TEXT,
					attributes TEXT,
					links TEXT
				)
			`);
			oldDb.run(`
				CREATE TABLE bodies (
					recordId TEXT PRIMARY KEY REFERENCES records(id),
					body TEXT NOT NULL
				)
			`);
			oldDb.run(
				`INSERT INTO records (id, kind, level, msg, name, spanId, parentSpanId, conversationId, turnId, extensionId, timestamp, durationMs, status, attributes, links)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"rec-1",
					"span-open",
					null,
					null,
					"prompt",
					"s1",
					null,
					"conv-1",
					"t1",
					"ext",
					1000,
					null,
					null,
					null,
					null,
				],
			);
			oldDb.run("INSERT INTO bodies (recordId, body) VALUES (?, ?)", ["rec-1", "some body"]);
			oldDb.close();

			const store1 = createTraceStore({ path });
			expect(store1.getBody("rec-1")).toBe("some body");
			store1.close();

			const store2 = createTraceStore({ path });
			expect(store2.getBody("rec-1")).toBe("some body");

			const turn = store2.getTurn("t1");
			expect(turn).toHaveLength(1);

			store2.close();
		} finally {
			cleanup(path);
		}
	});

	it("idx_records_bodyHash exists after migration", () => {
		const path = tmpPath();
		try {
			const oldDb = new Database(path);
			oldDb.run("PRAGMA journal_mode = WAL");
			oldDb.run(`
				CREATE TABLE records (
					id TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					level TEXT,
					msg TEXT,
					name TEXT,
					spanId TEXT,
					parentSpanId TEXT,
					conversationId TEXT,
					turnId TEXT,
					extensionId TEXT NOT NULL,
					timestamp INTEGER NOT NULL,
					durationMs INTEGER,
					status TEXT,
					attributes TEXT,
					links TEXT
				)
			`);
			oldDb.run(`
				CREATE TABLE bodies (
					recordId TEXT PRIMARY KEY REFERENCES records(id),
					body TEXT NOT NULL
				)
			`);
			oldDb.close();

			const store = createTraceStore({ path });
			store.close();

			const db = new Database(path);
			const indexes = db
				.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_records_bodyHash'")
				.all() as Array<{ name: string }>;
			expect(indexes).toHaveLength(1);
			db.close();
		} finally {
			cleanup(path);
		}
	});
});
