import { Database } from "bun:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Attributes, LogRecord, SpanLink } from "@dispatch/kernel";
import { renderEasyView } from "./easy-view.js";

const COMPRESS_THRESHOLD_BYTES = 1024;

export interface RetentionPolicy {
	readonly maxAgeMs?: number;
	readonly maxTotalBodyBytes?: number;
}

export const DEFAULT_RETENTION: Required<RetentionPolicy> = {
	maxAgeMs: 7 * 24 * 60 * 60 * 1000,
	maxTotalBodyBytes: 256 * 1024 * 1024,
};

export interface PruneSummary {
	recordsDeleted: number;
	bodiesDeleted: number;
	bytesReclaimed: number;
}

export interface TraceStore {
	insertRecords(records: readonly LogRecord[]): void;
	getTurn(turnId: string): LogRecord[];
	getBody(recordId: string): string | undefined;
	easyView(turnId: string): string;
	prune(policy: RetentionPolicy): PruneSummary;
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
		prune(policy) {
			return prune(db, policy);
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
			links TEXT,
			bodyHash TEXT
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_records_turnId ON records(turnId)");
	db.run("CREATE INDEX IF NOT EXISTS idx_records_conversationId ON records(conversationId)");
	db.run("CREATE INDEX IF NOT EXISTS idx_records_spanId ON records(spanId)");
	db.run("CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind)");
	db.run("CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records(timestamp)");
	db.run("CREATE INDEX IF NOT EXISTS idx_records_bodyHash ON records(bodyHash)");

	db.run(`
		CREATE TABLE IF NOT EXISTS bodies (
			hash TEXT PRIMARY KEY,
			body BLOB NOT NULL,
			isCompressed INTEGER NOT NULL DEFAULT 0,
			originalSize INTEGER NOT NULL,
			storedSize INTEGER NOT NULL
		)
	`);

	migrateOldBodies(db);
}

function migrateOldBodies(db: Database): void {
	const hasOldTable = db
		.query("SELECT name FROM sqlite_master WHERE type='table' AND name='bodies_old'")
		.get() as { name: string } | null;
	if (hasOldTable !== null) {
		return;
	}

	const cols = db.query("PRAGMA table_info(bodies)").all() as Array<{
		name: string;
	}>;
	const hasRecordId = cols.some((c) => c.name === "recordId");
	if (!hasRecordId) {
		return;
	}

	const oldRows = db.query("SELECT recordId, body FROM bodies").all() as Array<{
		recordId: string;
		body: string;
	}>;

	db.run("ALTER TABLE bodies RENAME TO bodies_old");

	db.run(`
		CREATE TABLE IF NOT EXISTS bodies (
			hash TEXT PRIMARY KEY,
			body BLOB NOT NULL,
			isCompressed INTEGER NOT NULL DEFAULT 0,
			originalSize INTEGER NOT NULL,
			storedSize INTEGER NOT NULL
		)
	`);

	const hasBodyHash = cols.some((c) => c.name === "bodyHash");
	if (!hasBodyHash) {
		db.run("ALTER TABLE records ADD COLUMN bodyHash TEXT");
	}

	const upsertBody = db.prepare(`
		INSERT OR IGNORE INTO bodies (hash, body, isCompressed, originalSize, storedSize)
		VALUES (?, ?, 0, ?, ?)
	`);
	const updateRecord = db.prepare("UPDATE records SET bodyHash = ? WHERE id = ?");

	const migrateTxn = db.transaction(() => {
		for (const row of oldRows) {
			const hash = contentHash(row.body);
			const bodyBytes = new TextEncoder().encode(row.body);
			upsertBody.run(hash, bodyBytes, bodyBytes.length, bodyBytes.length);
			updateRecord.run(hash, row.recordId);
		}
		db.run("DROP TABLE bodies_old");
	});
	migrateTxn();
}

function sha256Hex(input: string): string {
	const data = new TextEncoder().encode(input);
	let h0 = 0x6a09e667;
	let h1 = 0xbb67ae85;
	let h2 = 0x3c6ef372;
	let h3 = 0xa54ff53a;
	let h4 = 0x510e527f;
	let h5 = 0x9b05688c;
	let h6 = 0x1f83d9ab;
	let h7 = 0x5be0cd19;

	const msgLen = data.length;
	const bitLen = msgLen * 8;
	const withOne = msgLen + 1;
	const paddedLen = withOne + ((96 - (withOne % 64)) % 64) + 8;
	const padded = new Uint8Array(paddedLen);
	padded.set(data);
	padded[msgLen] = 0x80;
	padded[paddedLen - 8] = (bitLen / 0x100000000) >>> 0;
	padded[paddedLen - 4] = bitLen >>> 0;

	const kArr = new Uint32Array(K);

	for (let offset = 0; offset < paddedLen; offset += 64) {
		const w = new Uint32Array(64);
		for (let i = 0; i < 16; i++) {
			const o = offset + i * 4;
			const b0 = padded[o] ?? 0;
			const b1 = padded[o + 1] ?? 0;
			const b2 = padded[o + 2] ?? 0;
			const b3 = padded[o + 3] ?? 0;
			w[i] = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
		}
		for (let i = 16; i < 64; i++) {
			const prev15 = w[i - 15] ?? 0;
			const prev2 = w[i - 2] ?? 0;
			const prev16 = w[i - 16] ?? 0;
			const prev7 = w[i - 7] ?? 0;
			const s0 = rightRotate(prev15, 7) ^ rightRotate(prev15, 18) ^ (prev15 >>> 3);
			const s1 = rightRotate(prev2, 17) ^ rightRotate(prev2, 19) ^ (prev2 >>> 10);
			w[i] = (prev16 + s0 + prev7 + s1) | 0;
		}

		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;

		for (let i = 0; i < 64; i++) {
			const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
			const ch = (e & f) ^ (~e & g);
			const ki = kArr[i] ?? 0;
			const wi = w[i] ?? 0;
			const temp1 = (h + S1 + ch + ki + wi) | 0;
			const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) | 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) | 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) | 0;
		}

		h0 = (h0 + a) | 0;
		h1 = (h1 + b) | 0;
		h2 = (h2 + c) | 0;
		h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0;
		h5 = (h5 + f) | 0;
		h6 = (h6 + g) | 0;
		h7 = (h7 + h) | 0;
	}

	return (
		toHex32(h0) +
		toHex32(h1) +
		toHex32(h2) +
		toHex32(h3) +
		toHex32(h4) +
		toHex32(h5) +
		toHex32(h6) +
		toHex32(h7)
	);
}

function rightRotate(x: number, n: number): number {
	return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function toHex32(n: number): string {
	return (n >>> 0).toString(16).padStart(8, "0");
}

const K = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function contentHash(body: string): string {
	return sha256Hex(body);
}

function compressBody(body: string): { stored: Uint8Array; isCompressed: boolean } {
	const raw = new TextEncoder().encode(body);
	if (raw.length <= COMPRESS_THRESHOLD_BYTES) {
		return { stored: raw, isCompressed: false };
	}
	const compressed = gzipSync(raw);
	if (compressed.length >= raw.length) {
		return { stored: raw, isCompressed: false };
	}
	return { stored: compressed, isCompressed: true };
}

function decompressBody(stored: Uint8Array, isCompressed: boolean): string {
	if (!isCompressed) {
		return new TextDecoder().decode(stored);
	}
	const decompressed = gunzipSync(stored);
	return new TextDecoder().decode(decompressed);
}

function storeBody(db: Database, body: string): string {
	const hash = contentHash(body);
	const existing = db.query("SELECT 1 FROM bodies WHERE hash = ?").get(hash) as unknown;
	if (existing !== null) {
		return hash;
	}
	const { stored, isCompressed } = compressBody(body);
	db.prepare(
		"INSERT OR IGNORE INTO bodies (hash, body, isCompressed, originalSize, storedSize) VALUES (?, ?, ?, ?, ?)",
	).run(hash, stored, isCompressed ? 1 : 0, new TextEncoder().encode(body).length, stored.length);
	return hash;
}

function resolveBody(db: Database, hash: string | null): string | undefined {
	if (hash === null) {
		return undefined;
	}
	const row = db.query("SELECT body, isCompressed FROM bodies WHERE hash = ?").get(hash) as {
		body: Uint8Array;
		isCompressed: number;
	} | null;
	if (row === undefined || row === null) {
		return undefined;
	}
	return decompressBody(row.body, row.isCompressed === 1);
}

function insertRecords(db: Database, records: readonly LogRecord[]): void {
	const recStmt = db.prepare(`
		INSERT OR IGNORE INTO records
			(id, kind, level, msg, name, spanId, parentSpanId,
			 conversationId, turnId, extensionId, timestamp,
			 durationMs, status, attributes, links, bodyHash)
		VALUES
			(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

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

			let bodyHash: string | null = null;
			if (r.body !== undefined) {
				bodyHash = storeBody(db, r.body);
			}

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
				bodyHash,
			);
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
	bodyHash: string | null;
}

function getTurn(db: Database, turnId: string): LogRecord[] {
	const rows = db
		.query("SELECT * FROM records WHERE turnId = ? ORDER BY timestamp ASC, rowid ASC")
		.all(turnId) as RecordRow[];
	return rows.map((row) => rowToRecord(db, row));
}

function getBody(db: Database, recordId: string): string | undefined {
	const row = db.query("SELECT bodyHash FROM records WHERE id = ?").get(recordId) as {
		bodyHash: string | null;
	} | null;
	if (row === undefined || row === null || row.bodyHash === null) {
		return undefined;
	}
	return resolveBody(db, row.bodyHash);
}

function rowToRecord(db: Database, row: RecordRow): LogRecord {
	const attributes: Attributes | undefined =
		row.attributes !== null ? JSON.parse(row.attributes) : undefined;
	const links: SpanLink[] | undefined = row.links !== null ? JSON.parse(row.links) : undefined;
	const body: string | undefined = resolveBody(db, row.bodyHash);

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
			...(body !== undefined && { body }),
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
			...(body !== undefined && { body }),
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
		...(body !== undefined && { body }),
	};
	return record;
}

interface BodyRow {
	hash: string;
	storedSize: number;
}

interface BodyWithTimestamp extends BodyRow {
	oldestRecordTimestamp: number;
}

export function computeEvictions(
	bodies: readonly BodyWithTimestamp[],
	maxTotalBodyBytes: number,
): string[] {
	let totalBytes = 0;
	for (const b of bodies) {
		totalBytes += b.storedSize;
	}
	if (totalBytes <= maxTotalBodyBytes) {
		return [];
	}

	const sorted = [...bodies].sort((a, b) => a.oldestRecordTimestamp - b.oldestRecordTimestamp);
	const evict: string[] = [];
	let remaining = totalBytes;
	for (const b of sorted) {
		if (remaining <= maxTotalBodyBytes) {
			break;
		}
		evict.push(b.hash);
		remaining -= b.storedSize;
	}
	return evict;
}

function prune(db: Database, policy: RetentionPolicy): PruneSummary {
	let recordsDeleted = 0;
	let bodiesDeleted = 0;
	let bytesReclaimed = 0;

	const now = Date.now();

	if (policy.maxAgeMs !== undefined) {
		const cutoff = now - policy.maxAgeMs;
		const oldRecords = db
			.query("SELECT id, bodyHash FROM records WHERE timestamp < ?")
			.all(cutoff) as Array<{ id: string; bodyHash: string | null }>;

		if (oldRecords.length > 0) {
			const bodyHashes = oldRecords.map((r) => r.bodyHash).filter((h): h is string => h !== null);

			const deleteTxn = db.transaction(() => {
				db.prepare("DELETE FROM records WHERE timestamp < ?").run(cutoff);
				for (const hash of bodyHashes) {
					const refCount = db
						.query("SELECT COUNT(*) as cnt FROM records WHERE bodyHash = ?")
						.get(hash) as { cnt: number };
					if (refCount.cnt === 0) {
						const bodyRow = db.query("SELECT storedSize FROM bodies WHERE hash = ?").get(hash) as {
							storedSize: number;
						} | null;
						if (bodyRow !== undefined && bodyRow !== null) {
							bytesReclaimed += bodyRow.storedSize;
						}
						db.prepare("DELETE FROM bodies WHERE hash = ?").run(hash);
						bodiesDeleted++;
					}
				}
			});
			deleteTxn();
			recordsDeleted = oldRecords.length;
		}
	}

	if (policy.maxTotalBodyBytes !== undefined) {
		const bodyRows = db
			.query(`
				SELECT b.hash, b.storedSize, MIN(r.timestamp) as oldestRecordTimestamp
				FROM bodies b
				JOIN records r ON r.bodyHash = b.hash
				GROUP BY b.hash
			`)
			.all() as Array<{ hash: string; storedSize: number; oldestRecordTimestamp: number }>;

		const toEvict = computeEvictions(bodyRows, policy.maxTotalBodyBytes);

		if (toEvict.length > 0) {
			const evictTxn = db.transaction(() => {
				for (const hash of toEvict) {
					const bodyRow = db.query("SELECT storedSize FROM bodies WHERE hash = ?").get(hash) as {
						storedSize: number;
					} | null;
					if (bodyRow !== undefined && bodyRow !== null) {
						bytesReclaimed += bodyRow.storedSize;
					}
					db.prepare("DELETE FROM records WHERE bodyHash = ?").run(hash);
					db.prepare("DELETE FROM bodies WHERE hash = ?").run(hash);
					bodiesDeleted++;
				}
			});
			evictTxn();
			recordsDeleted += toEvict.length;
		}
	}

	return { recordsDeleted, bodiesDeleted, bytesReclaimed };
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
