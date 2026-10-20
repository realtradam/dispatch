import type { StorageNamespace, SyncStorageTx } from "../contracts/extension.js";

/** Shared in-memory storage edge for tests; the supplied Map remains observable. */
export function storageFromMap(data = new Map<string, string>()): StorageNamespace {
  // Compare Unicode code points, matching SQLite BINARY's UTF-8 ordering.
  const compare = (a: string, b: string): number => {
    const left = Array.from(a, (c) => c.codePointAt(0) ?? 0);
    const right = Array.from(b, (c) => c.codePointAt(0) ?? 0);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0);
      if (diff) return diff;
    }
    return left.length - right.length;
  };
  const tx: SyncStorageTx = {
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
    delete: (key) => {
      data.delete(key);
    },
    entries: (prefix, opts = {}) => {
      if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 0)) {
        throw new RangeError("Storage entries limit must be a nonnegative safe integer");
      }
      const rows = [...data.entries()].filter(
        ([key]) =>
          key.startsWith(prefix) &&
          (opts.startAfter === undefined || compare(key, opts.startAfter) > 0) &&
          (opts.endBefore === undefined || compare(key, opts.endBefore) < 0),
      );
      rows.sort(([a], [b]) => compare(a, b) * (opts.reverse ? -1 : 1));
      return opts.limit === undefined ? rows : rows.slice(0, opts.limit);
    },
  };
  return {
    get: async (key) => tx.get(key),
    set: async (key, value) => tx.set(key, value),
    delete: async (key) => tx.delete(key),
    has: async (key) => data.has(key),
    keys: async (prefix = "") => tx.entries(prefix).map(([key]) => key),
    entries: async (prefix, opts) => tx.entries(prefix, opts),
    count: async (prefix) => tx.entries(prefix).length,
    transaction: async (fn) => {
      const snapshot = new Map(data);
      try {
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
      } catch (error) {
        data.clear();
        for (const [key, value] of snapshot) data.set(key, value);
        throw error;
      }
    },
  };
}
