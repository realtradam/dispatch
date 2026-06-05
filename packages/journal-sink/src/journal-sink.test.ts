import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord } from "@dispatch/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClockOps, FsOps } from "./journal-sink.js";
import { createJournalSink, serialize } from "./journal-sink.js";

// --- Fixtures: one per LogRecord variant ---

const logRecord: LogRecord = {
	kind: "log",
	level: "info",
	msg: "hello world",
	timestamp: 1700000000000,
	extensionId: "test-ext",
	conversationId: "conv-1",
	turnId: "turn-1",
	spanId: "span-1",
	attributes: { key: "value" },
};

const logRecordMinimal: LogRecord = {
	kind: "log",
	level: "debug",
	msg: "minimal",
	timestamp: 1700000000001,
	extensionId: "ext-min",
};

const spanOpenRecord: LogRecord = {
	kind: "span-open",
	spanId: "span-2",
	name: "provider.request",
	timestamp: 1700000000100,
	extensionId: "test-ext",
	conversationId: "conv-1",
	turnId: "turn-1",
	parentSpanId: "span-1",
	attributes: { model: "gpt-4" },
	links: [{ spanId: "span-0", turnId: "turn-0", reason: "caused-by" }],
	body: "verbatim request body",
};

const spanOpenRecordMinimal: LogRecord = {
	kind: "span-open",
	spanId: "span-3",
	name: "tool.call",
	timestamp: 1700000000200,
	extensionId: "ext-tool",
};

const spanCloseRecord: LogRecord = {
	kind: "span-close",
	spanId: "span-2",
	name: "provider.request",
	timestamp: 1700000000500,
	durationMs: 400,
	status: "ok",
	extensionId: "test-ext",
	conversationId: "conv-1",
	turnId: "turn-1",
	parentSpanId: "span-1",
	attributes: { cacheHit: true },
	links: [{ spanId: "span-0" }],
};

const spanCloseRecordError: LogRecord = {
	kind: "span-close",
	spanId: "span-4",
	name: "failing-step",
	timestamp: 1700000000600,
	durationMs: 100,
	status: "error",
	extensionId: "ext-err",
};

// --- Pure core: serialize ---

describe("serialize", () => {
	const allRecords = [
		{ name: "log (full)", record: logRecord },
		{ name: "log (minimal)", record: logRecordMinimal },
		{ name: "span-open (full)", record: spanOpenRecord },
		{ name: "span-open (minimal)", record: spanOpenRecordMinimal },
		{ name: "span-close (full)", record: spanCloseRecord },
		{ name: "span-close (error)", record: spanCloseRecordError },
	];

	for (const { name, record } of allRecords) {
		it(`produces exactly one NDJSON line for ${name}`, () => {
			const line = serialize(record);
			expect(line.endsWith("\n")).toBe(true);
			expect(line.endsWith("\n\n")).toBe(false);
			const parsed = JSON.parse(line);
			expect(parsed).toEqual(record);
		});

		it(`round-trips ${name} through JSON.parse`, () => {
			const line = serialize(record);
			const roundTripped: LogRecord = JSON.parse(line);
			expect(roundTripped).toEqual(record);
			expect(roundTripped.kind).toBe(record.kind);
		});
	}

	it("preserves all LogRecord variant kinds", () => {
		expect(JSON.parse(serialize(logRecord)).kind).toBe("log");
		expect(JSON.parse(serialize(spanOpenRecord)).kind).toBe("span-open");
		expect(JSON.parse(serialize(spanCloseRecord)).kind).toBe("span-close");
	});

	it("preserves optional fields when present", () => {
		const parsed = JSON.parse(serialize(spanOpenRecord));
		expect(parsed.body).toBe("verbatim request body");
		expect(parsed.links).toEqual([{ spanId: "span-0", turnId: "turn-0", reason: "caused-by" }]);
		expect(parsed.attributes).toEqual({ model: "gpt-4" });
	});

	it("omits optional fields when absent (no undefined in output)", () => {
		const parsed = JSON.parse(serialize(logRecordMinimal));
		expect(parsed.conversationId).toBeUndefined();
		expect(parsed.turnId).toBeUndefined();
		expect(parsed.spanId).toBeUndefined();
		expect(parsed.attributes).toBeUndefined();
		expect(parsed.body).toBeUndefined();
		expect("conversationId" in parsed).toBe(false);
	});
});

// --- Imperative shell: createJournalSink (fs integration) ---

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "journal-sink-test-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("createJournalSink", () => {
	it("emits records that can be read back as NDJSON", async () => {
		const path = join(tmpDir, "journal.log");
		const sink = createJournalSink({ path, fsync: "none" });

		const records = [logRecord, spanOpenRecord, spanCloseRecord];
		for (const r of records) {
			sink.emit(r);
		}

		const content = await readFile(path, "utf8");
		const lines = content.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(3);

		for (let i = 0; i < lines.length; i++) {
			const parsed: LogRecord = JSON.parse(lines[i] ?? "");
			expect(parsed).toEqual(records[i]);
		}
	});

	it("warns and does NOT throw when writing to a bad path", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const badPath = join(tmpDir, "nonexistent", "deep", "journal.log");
		const sink = createJournalSink({ path: badPath, fsync: "none" });

		expect(() => sink.emit(logRecord)).not.toThrow();
		expect(warnSpy).toHaveBeenCalled();
		expect(warnSpy.mock.calls[0]?.[0]).toContain("[journal-sink]");

		warnSpy.mockRestore();
	});

	it("appends to existing file on creation", async () => {
		const path = join(tmpDir, "journal.log");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, serialize(logRecord));

		const sink = createJournalSink({ path, fsync: "none" });
		sink.emit(spanOpenRecord);

		const content = await readFile(path, "utf8");
		const lines = content.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "").kind).toBe("log");
		expect(JSON.parse(lines[1] ?? "").kind).toBe("span-open");
	});

	it("warns and drops records when fs.write throws mid-emit", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const brokenFs: FsOps = {
			open: () => 1,
			write: () => {
				throw new Error("disk full");
			},
			close: () => {},
			rename: () => {},
			statSize: () => 0,
			fsync: () => {},
		};
		const sink = createJournalSink({ path: join(tmpDir, "j.log"), fs: brokenFs, fsync: "none" });

		expect(() => sink.emit(logRecord)).not.toThrow();
		expect(warnSpy).toHaveBeenCalled();
		expect(warnSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error);

		warnSpy.mockRestore();
	});
});

// --- Rotation ---

describe("rotation", () => {
	it("rotates when file exceeds maxBytes", async () => {
		const path = join(tmpDir, "journal.log");
		const sink = createJournalSink({ path, maxBytes: 100, fsync: "none" });

		sink.emit(logRecord);
		sink.emit(logRecordMinimal);
		sink.emit(spanOpenRecord);

		const content = await readFile(path, "utf8");
		const lines = content.split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBeGreaterThan(0);

		let rotatedExists = false;
		try {
			await stat(`${path}.1`);
			rotatedExists = true;
		} catch {
			// May not exist if rotation hasn't triggered yet.
		}
		expect(rotatedExists).toBe(true);

		const rotatedContent = await readFile(`${path}.1`, "utf8");
		const allLines = [...rotatedContent.split("\n").filter((l) => l.length > 0), ...lines];
		for (const line of allLines) {
			const parsed = JSON.parse(line);
			expect(["log", "span-open", "span-close"]).toContain(parsed.kind);
		}
	});
});

// --- Fsync ---

describe("fsync", () => {
	it("calls fsync periodically when mode is periodic", () => {
		let fsyncCalls = 0;
		let currentTime = 0;
		const mockFs: FsOps = {
			open: () => 1,
			write: () => {},
			close: () => {},
			rename: () => {},
			statSize: () => 0,
			fsync: () => {
				fsyncCalls++;
			},
		};
		const mockClock: ClockOps = {
			now: () => currentTime,
		};
		const sink = createJournalSink({
			path: join(tmpDir, "j.log"),
			fs: mockFs,
			clock: mockClock,
			fsync: "periodic",
		});

		sink.emit(logRecord);
		expect(fsyncCalls).toBe(0);

		currentTime = 6_000;
		sink.emit(logRecordMinimal);
		expect(fsyncCalls).toBe(1);

		sink.emit(spanOpenRecord);
		expect(fsyncCalls).toBe(1);

		currentTime = 12_000;
		sink.emit(spanCloseRecord);
		expect(fsyncCalls).toBe(2);
	});

	it("never calls fsync when mode is none", () => {
		let fsyncCalls = 0;
		const mockFs: FsOps = {
			open: () => 1,
			write: () => {},
			close: () => {},
			rename: () => {},
			statSize: () => 0,
			fsync: () => {
				fsyncCalls++;
			},
		};
		const sink = createJournalSink({
			path: join(tmpDir, "j.log"),
			fs: mockFs,
			fsync: "none",
		});

		sink.emit(logRecord);
		sink.emit(logRecord);
		sink.emit(logRecord);
		expect(fsyncCalls).toBe(0);
	});
});
