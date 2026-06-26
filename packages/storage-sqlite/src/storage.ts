import { Database } from "bun:sqlite";
import type { StorageNamespace } from "@dispatch/kernel";
import { computePending, type Migration } from "./migrate.js";

export interface SqliteStorageBackend {
  readonly storage: (namespace: string) => StorageNamespace;
  readonly migrate: (namespace: string, migrations: readonly Migration[]) => Promise<void>;
  readonly close: () => void;
}

export type StorageFactory = (opts: { path: string }) => SqliteStorageBackend;

export function createSqliteStorage(opts: { path: string }): SqliteStorageBackend {
  const db = new Database(opts.path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
		CREATE TABLE IF NOT EXISTS kv (
			namespace TEXT NOT NULL,
			key       TEXT NOT NULL,
			value     TEXT NOT NULL,
			PRIMARY KEY (namespace, key)
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			namespace  TEXT NOT NULL,
			version    INTEGER NOT NULL,
			name       TEXT NOT NULL,
			applied_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (namespace, version)
		);
	`);

  const getStmt = db.prepare("SELECT value FROM kv WHERE namespace = ?1 AND key = ?2");
  const setStmt = db.prepare(
    "INSERT OR REPLACE INTO kv (namespace, key, value) VALUES (?1, ?2, ?3)",
  );
  const deleteStmt = db.prepare("DELETE FROM kv WHERE namespace = ?1 AND key = ?2");
  const hasStmt = db.prepare("SELECT 1 FROM kv WHERE namespace = ?1 AND key = ?2");
  const keysAllStmt = db.prepare("SELECT key FROM kv WHERE namespace = ?1");
  const keysPrefixStmt = db.prepare("SELECT key FROM kv WHERE namespace = ?1 AND key LIKE ?2");
  const appliedVersionsStmt = db.prepare("SELECT version FROM _migrations WHERE namespace = ?1");
  const recordMigrationStmt = db.prepare(
    "INSERT INTO _migrations (namespace, version, name) VALUES (?1, ?2, ?3)",
  );

  function storage(namespace: string): StorageNamespace {
    return {
      get: async (key: string) => {
        const row = getStmt.get(namespace, key) as { value: string } | null;
        return row?.value ?? null;
      },
      set: async (key: string, value: string) => {
        setStmt.run(namespace, key, value);
      },
      delete: async (key: string) => {
        deleteStmt.run(namespace, key);
      },
      has: async (key: string) => {
        return hasStmt.get(namespace, key) !== null;
      },
      keys: async (prefix?: string) => {
        if (prefix !== undefined) {
          const rows = keysPrefixStmt.all(namespace, `${prefix}%`) as { key: string }[];
          return rows.map((r) => r.key);
        }
        const rows = keysAllStmt.all(namespace) as { key: string }[];
        return rows.map((r) => r.key);
      },
    };
  }

  async function migrate(namespace: string, migrations: readonly Migration[]): Promise<void> {
    const rows = appliedVersionsStmt.all(namespace) as { version: number }[];
    const applied = new Set(rows.map((r) => r.version));
    const pending = computePending(applied, migrations);

    for (const m of pending) {
      const runInTransaction = db.transaction(() => {
        db.exec(m.up);
        recordMigrationStmt.run(namespace, m.version, m.name);
      });
      runInTransaction();
    }
  }

  function close(): void {
    db.close();
  }

  return { storage, migrate, close };
}
