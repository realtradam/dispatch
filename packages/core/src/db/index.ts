import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

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
		id          TEXT PRIMARY KEY,
		title       TEXT NOT NULL,
		key_id      TEXT,
		model_id    TEXT,
		status      TEXT NOT NULL DEFAULT 'idle',
		is_open     INTEGER NOT NULL DEFAULT 1,
		position    INTEGER NOT NULL DEFAULT 0,
		created_at  INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL
	)`);

	_db.run(`CREATE TABLE IF NOT EXISTS messages (
		id           TEXT PRIMARY KEY,
		tab_id       TEXT NOT NULL REFERENCES tabs(id),
		seq          INTEGER NOT NULL,
		role         TEXT NOT NULL,
		content_json TEXT NOT NULL,
		thinking     TEXT,
		created_at   INTEGER NOT NULL
	)`);

	_db.run(`CREATE INDEX IF NOT EXISTS idx_messages_tab ON messages(tab_id, seq)`);

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
