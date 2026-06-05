import { Database } from "bun:sqlite";
import type { Attributes, LogRecord, SpanLink } from "@dispatch/kernel";
import { renderEasyView } from "./easy-view.js";

export interface TraceStore {
	insertRecords(records: readonly LogRecord[]): void;
	getTurn(turnId: string): LogRecord[];
	getBody(recordId: string): string | undefined;
	easyView(turnId: string): string;
	close(): void;
}

export function createTraceStore(opts: { path: string }): TraceStore {
	const db = new Database(opts.path);
	db.run("PRAGMA journal_mode = WAL");
	schema(db);
	return {
		insertRecords(records) {
			insertRecords(db, records);
		},
		getTurn(turnId) {
			return getTurn(db, turnId);
		},
		getBody(recordId) {
			return getBody(db, recordId);
		},
		easyView(turnId) {
			return renderEasyView(getTurn(db, turnId));
		},
		close() {
			db.close();
		},
	};
}

function schema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS records (
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
	db.run("CREATE INDEX IF NOT EXISTS idx_records_turnId ON records(turnId)");
	db.run("CREATE INDEX IF NOT EXISTS idx_records_conversationId ON records(conversationId)");
	db.run("CREATE INDEX IF NOT EXISTS idx_records_spanId ON records(spanId)");
	db.run("CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind)");
	db.run("CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records(timestamp)");

	db.run(`
		CREATE TABLE IF NOT EXISTS bodies (
			recordId TEXT PRIMARY KEY REFERENCES records(id),
			body TEXT NOT NULL
		)
	`);
}

function insertRecords(db: Database, records: readonly LogRecord[]): void {
	const recStmt = db.prepare(`
		INSERT OR IGNORE INTO records
			(id, kind, level, msg, name, spanId, parentSpanId,
			 conversationId, turnId, extensionId, timestamp,
			 durationMs, status, attributes, links)
		VALUES
			(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const bodyStmt = db.prepare("INSERT OR IGNORE INTO bodies (recordId, body) VALUES (?, ?)");

	const txn = db.transaction(() => {
		for (const r of records) {
			const id = stableId(r);
			const kind = r.kind;
			let level: string | null = null;
			let msg: string | null = null;
			let name: string | null = null;
			let spanId: string | null = null;
			let parentSpanId: string | null = null;
			let durationMs: number | null = null;
			let status: string | null = null;
			let links: string | null = null;

			if (r.kind === "log") {
				level = r.level;
				msg = r.msg;
				spanId = r.spanId ?? null;
				parentSpanId = r.parentSpanId ?? null;
			} else if (r.kind === "span-open") {
				name = r.name;
				spanId = r.spanId;
				parentSpanId = r.parentSpanId ?? null;
				if (r.links !== undefined) {
					links = JSON.stringify(r.links);
				}
			} else {
				name = r.name;
				spanId = r.spanId;
				parentSpanId = r.parentSpanId ?? null;
				durationMs = r.durationMs;
				status = r.status;
				if (r.links !== undefined) {
					links = JSON.stringify(r.links);
				}
			}

			const attributes: string | null =
				r.attributes !== undefined ? JSON.stringify(r.attributes) : null;

			recStmt.run(
				id,
				kind,
				level,
				msg,
				name,
				spanId,
				parentSpanId,
				r.conversationId ?? null,
				r.turnId ?? null,
				r.extensionId,
				r.timestamp,
				durationMs,
				status,
				attributes,
				links,
			);

			if (r.body !== undefined) {
				bodyStmt.run(id, r.body);
			}
		}
	});
	txn();
}

interface RecordRow {
	id: string;
	kind: string;
	level: string | null;
	msg: string | null;
	name: string | null;
	spanId: string | null;
	parentSpanId: string | null;
	conversationId: string | null;
	turnId: string | null;
	extensionId: string;
	timestamp: number;
	durationMs: number | null;
	status: string | null;
	attributes: string | null;
	links: string | null;
}

function getTurn(db: Database, turnId: string): LogRecord[] {
	const rows = db
		.query("SELECT * FROM records WHERE turnId = ? ORDER BY timestamp ASC, rowid ASC")
		.all(turnId) as RecordRow[];
	return rows.map(rowToRecord);
}

function getBody(db: Database, recordId: string): string | undefined {
	const row = db.query("SELECT body FROM bodies WHERE recordId = ?").get(recordId) as {
		body: string;
	} | null;
	return row?.body;
}

function rowToRecord(row: RecordRow): LogRecord {
	const attributes: Attributes | undefined =
		row.attributes !== null ? JSON.parse(row.attributes) : undefined;
	const links: SpanLink[] | undefined = row.links !== null ? JSON.parse(row.links) : undefined;

	if (row.kind === "log") {
		const record: LogRecord = {
			kind: "log",
			level: row.level as "debug" | "info" | "warn" | "error",
			msg: row.msg ?? "",
			timestamp: row.timestamp,
			extensionId: row.extensionId,
			...(row.conversationId !== null && { conversationId: row.conversationId }),
			...(row.turnId !== null && { turnId: row.turnId }),
			...(row.spanId !== null && { spanId: row.spanId }),
			...(row.parentSpanId !== null && { parentSpanId: row.parentSpanId }),
			...(attributes !== undefined && { attributes }),
		};
		return record;
	}

	if (row.kind === "span-open") {
		const record: LogRecord = {
			kind: "span-open",
			spanId: row.spanId ?? "",
			name: row.name ?? "",
			timestamp: row.timestamp,
			extensionId: row.extensionId,
			...(row.conversationId !== null && { conversationId: row.conversationId }),
			...(row.turnId !== null && { turnId: row.turnId }),
			...(row.parentSpanId !== null && { parentSpanId: row.parentSpanId }),
			...(attributes !== undefined && { attributes }),
			...(links !== undefined && { links }),
		};
		return record;
	}

	const record: LogRecord = {
		kind: "span-close",
		spanId: row.spanId ?? "",
		name: row.name ?? "",
		timestamp: row.timestamp,
		durationMs: row.durationMs ?? 0,
		status: (row.status as "ok" | "error") ?? "ok",
		extensionId: row.extensionId,
		...(row.conversationId !== null && { conversationId: row.conversationId }),
		...(row.turnId !== null && { turnId: row.turnId }),
		...(row.parentSpanId !== null && { parentSpanId: row.parentSpanId }),
		...(attributes !== undefined && { attributes }),
		...(links !== undefined && { links }),
	};
	return record;
}

function toCanonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(toCanonicalJson).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	const entries = keys.map((k) => `${JSON.stringify(k)}:${toCanonicalJson(obj[k])}`);
	return `{${entries.join(",")}}`;
}

export function stableId(record: LogRecord): string {
	const json = toCanonicalJson(record);
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	for (let i = 0; i < json.length; i++) {
		hash ^= BigInt(json.charCodeAt(i));
		hash = (hash * prime) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0");
}
