import type { LogRecord } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { createTraceStore, stableId } from "./store.js";

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

		const { unlinkSync } = require("node:fs");
		try {
			unlinkSync(tmpPath);
		} catch {
			// ignore cleanup error
		}
	});
});
