import { Database } from "bun:sqlite";
import type { StorageNamespace } from "@dispatch/kernel";
import { computePending, type Migration } from "./migrate.js";

export interface SqliteStorageBackend {
  readonly storage: (namespace: string) => StorageNamespace;
  readonly migrate: (namespace: string, migrations: readonly Migration[]) => Promise<void>;
  readonly close: () => void;
}

export type StorageFactory = (opts: { path: string }) => SqliteStorageBackend;

/** UTF-16 prefix successor; null means that no finite successor exists. */
export function prefixUpperBound(prefix: string): string | null {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const unit = prefix.charCodeAt(i);
    if (unit < 0xffff) {
      return prefix.slice(0, i) + String.fromCharCode(unit + 1);
    }
  }
  return null;
}

export function createSqliteStorage(opts: { path: string }): SqliteStorageBackend {
  const db = new Database(opts.path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
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
  const keysAllStmt = db.prepare("SELECT key FROM kv WHERE namespace = ?1 ORDER BY key");
  const keysPrefixStmt = db.prepare(
    "SELECT key FROM kv WHERE namespace = ?1 AND key >= ?2 AND key < ?3 ORDER BY key",
  );
  const keysFromStmt = db.prepare(
    "SELECT key FROM kv WHERE namespace = ?1 AND key >= ?2 ORDER BY key",
  );
  const appliedVersionsStmt = db.prepare("SELECT version FROM _migrations WHERE namespace = ?1");
  const recordMigrationStmt = db.prepare(
    "INSERT INTO _migrations (namespace, version, name) VALUES (?1, ?2, ?3)",
  );

  // Prepare each bounded query shape once; optional bounds remain index predicates.
  const entryStatements = new Map<string, ReturnType<typeof db.prepare>>();
  for (let flags = 0; flags < 16; flags++) {
    const predicates = ["namespace = $namespace", "key >= $prefix"];
    if (flags & 1) predicates.push("key < $upper");
    if (flags & 2) predicates.push("key > $after");
    if (flags & 4) predicates.push("key < $before");
    const sql = `SELECT key, value FROM kv WHERE ${predicates.join(" AND ")}
      ORDER BY key ${flags & 8 ? "DESC" : "ASC"} LIMIT $limit`;
    entryStatements.set(String(flags), db.prepare(sql));
  }
  const countRangeStmt = db.prepare(
    "SELECT count(*) AS n FROM kv WHERE namespace = ?1 AND key >= ?2 AND key < ?3",
  );
  const countFromStmt = db.prepare(
    "SELECT count(*) AS n FROM kv WHERE namespace = ?1 AND key >= ?2",
  );

  function storage(namespace: string): StorageNamespace {
    type Tx = Parameters<Parameters<StorageNamespace["transaction"]>[0]>[0];
    const entries: Tx["entries"] = (prefix, opts = {}) => {
      if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 0)) {
        throw new RangeError("Storage entries limit must be a nonnegative safe integer");
      }
      const upper = prefixUpperBound(prefix);
      const lowerOnly = upper === null || /[\ud800-\udfff]/u.test(upper);
      const filter = prefix !== "" && (lowerOnly || prefix.endsWith("\uffff"));
      const flags =
        (lowerOnly ? 0 : 1) |
        (opts.startAfter !== undefined ? 2 : 0) |
        (opts.endBefore !== undefined ? 4 : 0) |
        (opts.reverse ? 8 : 0);
      const stmt = entryStatements.get(String(flags));
      if (!stmt) throw new Error("Missing storage range statement");
      const rows = stmt.all({
        $namespace: namespace,
        $prefix: prefix,
        ...(!lowerOnly ? { $upper: upper } : {}),
        ...(opts.startAfter !== undefined ? { $after: opts.startAfter } : {}),
        ...(opts.endBefore !== undefined ? { $before: opts.endBefore } : {}),
        $limit: filter ? -1 : (opts.limit ?? -1),
      }) as { key: string; value: string }[];
      const matches = filter ? rows.filter((row) => row.key.startsWith(prefix)) : rows;
      return (filter && opts.limit !== undefined ? matches.slice(0, opts.limit) : matches).map(
        ({ key, value }) => [key, value] as const,
      );
    };
    const tx: Tx = {
      get: (key) => (getStmt.get(namespace, key) as { value: string } | null)?.value ?? null,
      set: (key, value) => {
        setStmt.run(namespace, key, value);
      },
      delete: (key) => {
        deleteStmt.run(namespace, key);
      },
      entries,
    };
    return {
      entries: async (prefix, opts) => entries(prefix, opts),
      count: async (prefix) => {
        const upper = prefixUpperBound(prefix);
        const lowerOnly = upper === null || /[\ud800-\udfff]/u.test(upper);
        if (prefix !== "" && (lowerOnly || prefix.endsWith("\uffff")))
          return entries(prefix).length;
        const row = (
          lowerOnly
            ? countFromStmt.get(namespace, prefix)
            : countRangeStmt.get(namespace, prefix, upper)
        ) as { n: number };
        return row.n;
      },
      transaction: async (fn) =>
        db.transaction(() => {
          const result = fn(tx);
          if (
            result !== null &&
            (typeof result === "object" || typeof result === "function") &&
            "then" in result &&
            typeof result.then === "function"
          ) {
            throw new TypeError("Storage transaction callback must be synchronous");
          }
          return result;
        })(),
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
        if (prefix !== undefined && prefix !== "") {
          const upper = prefixUpperBound(prefix);
          // A UTF-16 successor can be ill-formed at surrogate boundaries. SQLite
          // compares UTF-8 bytes, so use a lower-only index range in that case.
          const lowerOnly = upper === null || /[\ud800-\udfff]/u.test(upper);
          const rows = (
            lowerOnly
              ? keysFromStmt.all(namespace, prefix)
              : keysPrefixStmt.all(namespace, prefix, upper)
          ) as { key: string }[];
          const keys = rows.map((r) => r.key);
          // Dropping U+FFFF can include supplementary code points in UTF-8 order;
          // no-successor ranges can too. Keep those exceptional ranges literal.
          return lowerOnly || prefix.endsWith("\uffff")
            ? keys.filter((key) => key.startsWith(prefix))
            : keys;
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
