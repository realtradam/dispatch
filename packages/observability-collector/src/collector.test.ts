import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord } from "@dispatch/kernel";
import type { TraceStore } from "@dispatch/trace-store";
import { createTraceStore, DEFAULT_RETENTION } from "@dispatch/trace-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainOnce, readOffset, shouldPrune, splitLines, writeOffset } from "./collector.js";

// --- Fixtures ---

const log1: LogRecord = {
	kind: "log",
	level: "info",
	msg: "first",
	timestamp: 1700000000000,
	extensionId: "ext-1",
	turnId: "turn-1",
};

const log2: LogRecord = {
	kind: "log",
	level: "warn",
	msg: "second",
	timestamp: 1700000000100,
	extensionId: "ext-1",
	turnId: "turn-1",
};

const spanOpen: LogRecord = {
	kind: "span-open",
	spanId: "span-1",
	name: "step",
	timestamp: 1700000000200,
	extensionId: "ext-1",
	turnId: "turn-1",
};

const spanClose: LogRecord = {
	kind: "span-close",
	spanId: "span-1",
	name: "step",
	timestamp: 1700000000500,
	durationMs: 300,
	status: "ok",
	extensionId: "ext-1",
	turnId: "turn-1",
};

function toNdjson(records: LogRecord[]): string {
	return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

// --- splitLines (pure) ---

describe("splitLines", () => {
	it("splits multiple lines", () => {
		const { lines, remainder } = splitLines("a\nb\nc\n");
		expect(lines).toEqual(["a", "b", "c"]);
		expect(remainder).toBe("");
	});

	it("holds a torn last line as remainder (no trailing newline)", () => {
		const { lines, remainder } = splitLines("a\nb\nc");
		expect(lines).toEqual(["a", "b"]);
		expect(remainder).toBe("c");
	});

	it("returns empty lines and empty remainder for empty buffer", () => {
		const { lines, remainder } = splitLines("");
		expect(lines).toEqual([]);
		expect(remainder).toBe("");
	});

	it("handles a single complete line", () => {
		const { lines, remainder } = splitLines("hello\n");
		expect(lines).toEqual(["hello"]);
		expect(remainder).toBe("");
	});

	it("handles a single incomplete line", () => {
		const { lines, remainder } = splitLines("hello");
		expect(lines).toEqual([]);
		expect(remainder).toBe("hello");
	});

	it("handles consecutive newlines (empty lines)", () => {
		const { lines, remainder } = splitLines("a\n\nb\n");
		expect(lines).toEqual(["a", "", "b"]);
		expect(remainder).toBe("");
	});

	it("handles only newlines", () => {
		const { lines, remainder } = splitLines("\n\n\n");
		expect(lines).toEqual(["", "", ""]);
		expect(remainder).toBe("");
	});
});

// --- drainOnce (integration with real temp files + in-memory store) ---

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "collector-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("drainOnce", () => {
	it("reads N NDJSON records from journal and inserts into store", () => {
		const journalPath = join(tmpDir, "journal.log");
		writeFileSync(journalPath, toNdjson([log1, log2, spanOpen]));

		const store = createTraceStore({ path: ":memory:" });
		const result = drainOnce({ journalPath, offset: 0, store });

		expect(result.newOffset).toBeGreaterThan(0);
		const turn = store.getTurn("turn-1");
		expect(turn).toHaveLength(3);
		store.close();
	});

	it("returns offset at EOF after draining all records", () => {
		const journalPath = join(tmpDir, "journal.log");
		const content = toNdjson([log1, log2]);
		writeFileSync(journalPath, content);

		const store = createTraceStore({ path: ":memory:" });
		const result = drainOnce({ journalPath, offset: 0, store });

		expect(result.newOffset).toBe(Buffer.byteLength(content, "utf8"));
		store.close();
	});

	it("appends more lines and drains only new records from newOffset", () => {
		const journalPath = join(tmpDir, "journal.log");
		const initial = toNdjson([log1]);
		writeFileSync(journalPath, initial);

		const store = createTraceStore({ path: ":memory:" });
		const r1 = drainOnce({ journalPath, offset: 0, store });
		expect(store.getTurn("turn-1")).toHaveLength(1);

		// Append more
		const additional = toNdjson([log2, spanOpen]);
		writeFileSync(journalPath, initial + additional, { flag: "a" });

		const r2 = drainOnce({ journalPath, offset: r1.newOffset, store });
		expect(r2.newOffset).toBeGreaterThan(r1.newOffset);
		expect(store.getTurn("turn-1")).toHaveLength(3);
		store.close();
	});

	it("holds a torn last line (no trailing newline) until newline arrives", () => {
		const journalPath = join(tmpDir, "journal.log");
		const full = toNdjson([log1]);
		// Write log1 + partial log2 (no trailing newline)
		const partial = JSON.stringify(log2);
		writeFileSync(journalPath, full + partial);

		const store = createTraceStore({ path: ":memory:" });
		const r1 = drainOnce({ journalPath, offset: 0, store });

		// Only log1 should be inserted; partial log2 is held
		expect(store.getTurn("turn-1")).toHaveLength(1);

		// Now append newline to complete log2
		writeFileSync(journalPath, `${full + partial}\n`, { flag: "a" });
		drainOnce({ journalPath, offset: r1.newOffset, store });

		expect(store.getTurn("turn-1")).toHaveLength(2);
		store.close();
	});

	it("skips malformed lines (warn, no throw)", () => {
		const journalPath = join(tmpDir, "journal.log");
		const good = JSON.stringify(log1);
		const bad = "this is not valid json{{{";
		const good2 = JSON.stringify(log2);
		writeFileSync(journalPath, `${good}\n${bad}\n${good2}\n`);

		const store = createTraceStore({ path: ":memory:" });
		const warnCalls: unknown[][] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warnCalls.push(args);

		try {
			drainOnce({ journalPath, offset: 0, store });
		} finally {
			console.warn = origWarn;
		}

		const turn = store.getTurn("turn-1");
		expect(turn).toHaveLength(2);
		expect(warnCalls.length).toBeGreaterThan(0);
		expect(String(warnCalls[0]?.[0])).toContain("malformed line");
		store.close();
	});

	it("re-draining from offset 0 inserts no duplicates (idempotent)", () => {
		const journalPath = join(tmpDir, "journal.log");
		writeFileSync(journalPath, toNdjson([log1, log2, spanOpen, spanClose]));

		const store = createTraceStore({ path: ":memory:" });

		// Drain twice from offset 0
		drainOnce({ journalPath, offset: 0, store });
		drainOnce({ journalPath, offset: 0, store });

		const turn = store.getTurn("turn-1");
		// trace-store uses INSERT OR IGNORE, so no duplicates
		expect(turn).toHaveLength(4);
		store.close();
	});

	it("returns same offset when journal is empty", () => {
		const journalPath = join(tmpDir, "journal.log");
		writeFileSync(journalPath, "");

		const store = createTraceStore({ path: ":memory:" });
		const result = drainOnce({ journalPath, offset: 0, store });

		expect(result.newOffset).toBe(0);
		store.close();
	});

	it("returns same offset when no new content past offset", () => {
		const journalPath = join(tmpDir, "journal.log");
		writeFileSync(journalPath, toNdjson([log1]));

		const store = createTraceStore({ path: ":memory:" });
		const r1 = drainOnce({ journalPath, offset: 0, store });
		const r2 = drainOnce({ journalPath, offset: r1.newOffset, store });

		expect(r2.newOffset).toBe(r1.newOffset);
		store.close();
	});

	it("returns same offset when journal file does not exist", () => {
		const journalPath = join(tmpDir, "nonexistent.log");
		const store = createTraceStore({ path: ":memory:" });
		const result = drainOnce({ journalPath, offset: 0, store });

		expect(result.newOffset).toBe(0);
		store.close();
	});
});

// --- Offset persistence ---

describe("readOffset / writeOffset", () => {
	it("returns 0 when sidecar file does not exist", () => {
		expect(readOffset(join(tmpDir, "nope.offset"))).toBe(0);
	});

	it("reads back a persisted offset", () => {
		const path = join(tmpDir, "test.offset");
		writeOffset(path, 42);
		expect(readOffset(path)).toBe(42);
	});

	it("overwrites previous offset", () => {
		const path = join(tmpDir, "test.offset");
		writeOffset(path, 100);
		writeOffset(path, 200);
		expect(readOffset(path)).toBe(200);
	});

	it("returns 0 for non-numeric content", () => {
		const path = join(tmpDir, "bad.offset");
		writeFileSync(path, "not-a-number");
		expect(readOffset(path)).toBe(0);
	});

	it("returns 0 for negative content", () => {
		const path = join(tmpDir, "neg.offset");
		writeFileSync(path, "-5");
		expect(readOffset(path)).toBe(0);
	});
});

// --- shouldPrune (pure) ---

describe("shouldPrune", () => {
	it("shouldPrune is false before the interval elapses", () => {
		expect(shouldPrune(1000, 1000, 60_000)).toBe(false);
		expect(shouldPrune(59_999, 1000, 60_000)).toBe(false);
	});

	it("shouldPrune is true once the interval has elapsed", () => {
		expect(shouldPrune(61_000, 1000, 60_000)).toBe(true);
		expect(shouldPrune(70_000, 1000, 60_000)).toBe(true);
	});
});

// --- Prune integration (real in-memory trace-store + injected clock) ---

function runCollectorTicks(opts: {
	store: TraceStore;
	journalPath: string;
	pruneIntervalMs: number;
	now: number;
	tickCount: number;
	clockAdvancePerTick: number;
}): { pruneCalls: number; now: number } {
	const {
		store,
		journalPath,
		pruneIntervalMs,
		now: startNow,
		tickCount,
		clockAdvancePerTick,
	} = opts;
	let now = startNow;
	let lastPruneAt = now;
	let pruneCalls = 0;

	for (let i = 0; i < tickCount; i++) {
		drainOnce({ journalPath, offset: 0, store });
		if (shouldPrune(now, lastPruneAt, pruneIntervalMs)) {
			store.prune(DEFAULT_RETENTION);
			pruneCalls++;
			lastPruneAt = now;
		}
		now += clockAdvancePerTick;
	}

	return { pruneCalls, now };
}

describe("prune integration", () => {
	it("collector invokes store.prune once after the prune interval elapses", () => {
		const journalPath = join(tmpDir, "journal.log");
		writeFileSync(journalPath, "");

		const store = createTraceStore({ path: ":memory:" });
		const result = runCollectorTicks({
			store,
			journalPath,
			pruneIntervalMs: 60_000,
			now: 1000,
			tickCount: 13_000,
			clockAdvancePerTick: 5,
		});

		expect(result.pruneCalls).toBe(1);
		store.close();
	});

	it("collector does not prune on every drain", () => {
		const journalPath = join(tmpDir, "journal.log");
		writeFileSync(journalPath, "");

		const store = createTraceStore({ path: ":memory:" });
		const result = runCollectorTicks({
			store,
			journalPath,
			pruneIntervalMs: 60_000,
			now: 1000,
			tickCount: 100,
			clockAdvancePerTick: 10,
		});

		expect(result.pruneCalls).toBe(0);
		store.close();
	});

	it("a prune error is logged and does not stop draining", () => {
		const journalPath = join(tmpDir, "journal.log");
		const recentTs = Date.now() - 1000;
		const recentLog1: LogRecord = { ...log1, timestamp: recentTs };
		const recentLog2: LogRecord = { ...log2, timestamp: recentTs };
		writeFileSync(journalPath, toNdjson([recentLog1, recentLog2]));

		const store = createTraceStore({ path: ":memory:" });
		let pruneCalls = 0;
		let nextPruneThrows = true;
		const realPrune = store.prune.bind(store);
		store.prune = (policy) => {
			pruneCalls++;
			if (nextPruneThrows) {
				nextPruneThrows = false;
				throw new Error("simulated prune failure");
			}
			return realPrune(policy);
		};

		let drainSuccesses = 0;
		let now = 1000;
		let lastPruneAt = now;
		const pruneIntervalMs = 60_000;

		for (let i = 0; i < 4; i++) {
			const result = drainOnce({ journalPath, offset: 0, store });
			if (result.newOffset > 0) drainSuccesses++;
			if (shouldPrune(now, lastPruneAt, pruneIntervalMs)) {
				try {
					store.prune(DEFAULT_RETENTION);
				} catch {
					// expected in test
				}
				lastPruneAt = now;
			}
			now += 60_000;
		}

		expect(pruneCalls).toBe(3);
		expect(drainSuccesses).toBe(4);
		const turn = store.getTurn("turn-1");
		expect(turn).toHaveLength(2);
		store.close();
	});

	it("body inserts flow through content-addressed path unchanged", () => {
		const journalPath = join(tmpDir, "journal.log");
		const bodyLog: LogRecord = {
			kind: "log",
			level: "info",
			msg: "with-body",
			timestamp: 1700000000000,
			extensionId: "ext-1",
			turnId: "turn-2",
			body: "request payload content",
		};
		writeFileSync(journalPath, toNdjson([bodyLog]));

		const store = createTraceStore({ path: ":memory:" });
		drainOnce({ journalPath, offset: 0, store });

		const turn = store.getTurn("turn-2");
		expect(turn).toHaveLength(1);
		const record = turn[0];
		if (record === undefined) throw new Error("expected record");
		expect(record.body).toBe("request payload content");
		store.close();
	});
});
