import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Returns the directory for persistent Dispatch data, following XDG Base
 * Directory spec on Linux: `$XDG_DATA_HOME/dispatch` (defaults to
 * `~/.local/share/dispatch`).
 */
function getDataDir(): string {
	const xdg = process.env.XDG_DATA_HOME;
	const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share");
	return join(base, "dispatch");
}

let _db: Database | null = null;

/**
 * Get (or create) the singleton SQLite database.
 *
 * - Creates the data directory if it doesn't exist.
 * - Creates `dispatch.db` if it doesn't exist.
 * - Enables WAL journal mode for concurrent read performance.
 */
export function getDatabase(): Database {
	if (_db) return _db;

	const dir = getDataDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const dbPath = join(dir, "dispatch.db");
	_db = new Database(dbPath, { create: true });

	// WAL mode: better concurrent read performance, safe for single-writer
	_db.run("PRAGMA journal_mode = WAL;");
	// Recommended for WAL: normal synchronous is safe and faster
	_db.run("PRAGMA synchronous = NORMAL;");
	// Enable foreign keys
	_db.run("PRAGMA foreign_keys = ON;");

	// Create tables
	_db.run(`CREATE TABLE IF NOT EXISTS credentials (
		key_id            TEXT PRIMARY KEY,
		provider          TEXT NOT NULL,
		access_token      TEXT NOT NULL,
		refresh_token     TEXT NOT NULL,
		expires_at        INTEGER NOT NULL,
		subscription_type TEXT,
		source_file       TEXT,
		imported_at       INTEGER NOT NULL,
		updated_at        INTEGER NOT NULL
	)`);

	_db.run(`CREATE TABLE IF NOT EXISTS wake_schedule (
		hour         INTEGER PRIMARY KEY CHECK (hour BETWEEN 0 AND 23),
		next_wake_at INTEGER NOT NULL
	)`);

	_db.run(`CREATE TABLE IF NOT EXISTS usage_cache (
		key_id      TEXT PRIMARY KEY,
		provider    TEXT NOT NULL,
		cached_at   INTEGER NOT NULL,
		report_json TEXT NOT NULL
	)`);

	_db.run(`CREATE TABLE IF NOT EXISTS api_keys (
		key_id      TEXT PRIMARY KEY,
		provider    TEXT NOT NULL,
		api_key     TEXT NOT NULL,
		imported_at INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL
	)`);

	_db.run(`CREATE TABLE IF NOT EXISTS tabs (
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

	try {
		_db.run("ALTER TABLE tabs ADD COLUMN parent_tab_id TEXT");
	} catch {
		// Column already exists — ignore
	}

	// ─── Append-only chunk log (replaces the old `messages` blob table) ──
	//
	// A conversation is stored as a flat, append-only stream of chunk rows
	// keyed by a per-tab monotonic `seq`. "Message" and "turn" are DERIVED
	// groupings (see db/chunks.ts), never stored containers. This is what
	// powers per-chunk frontend pagination AND the stable per-step wire
	// format that fixes Anthropic prompt-cache churn (see plan-chunk-log.md).
	//
	//   role  : 'user' | 'assistant' | 'tool' | 'system'
	//   type  : 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'system'
	//   step  : LLM round-trip index within a turn (user/system rows = 0)
	//   data_json: the type-specific payload (see ChunkData in types)
	_db.run(`CREATE TABLE IF NOT EXISTS chunks (
		id          TEXT PRIMARY KEY,
		tab_id      TEXT NOT NULL,
		seq         INTEGER NOT NULL,
		turn_id     TEXT NOT NULL,
		step        INTEGER NOT NULL DEFAULT 0,
		role        TEXT NOT NULL,
		type        TEXT NOT NULL,
		data_json   TEXT NOT NULL,
		created_at  INTEGER NOT NULL
	)`);

	_db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_tab_seq ON chunks(tab_id, seq)`);

	// One-shot migration off the legacy `messages` blob model. Beta software,
	// no backward compatibility: the old chat history is destroyed (tabs +
	// messages), while settings / credentials / api_keys / usage_cache /
	// wake_schedule are preserved. Detect the old schema by the presence of
	// the `messages` table; once dropped, this branch never runs again.
	const hasLegacyMessages = _db
		.query("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
		.get() as { name: string } | null;
	if (hasLegacyMessages) {
		_db.run("DROP TABLE IF EXISTS messages");
		// Clear conversation containers too (fresh slate for the new model).
		_db.run("DELETE FROM tabs");
		_db.run("DELETE FROM chunks");
	}

	_db.run(`CREATE TABLE IF NOT EXISTS settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`);

	return _db;
}

/** Close the database connection (e.g. on shutdown). */
export function closeDatabase(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}

/** Returns the path where the database file lives (or will live). */
export function getDatabasePath(): string {
	if (_db) return _db.filename;
	const dir = getDataDir();
	return join(dir, "dispatch.db");
}
