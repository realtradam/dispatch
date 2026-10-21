import type { StorageNamespace } from "@dispatch/kernel";
import { CONVERSATION_INDEX_KEY, metaKey, modelKey, parentKey, tabGroupParentKey } from "./keys.js";

type StorageTx = Parameters<Parameters<StorageNamespace["transaction"]>[0]>[0];
/** Raw canonical values preserve malformed meta and absent/empty scalar semantics. */
export type ListingRow = readonly [string | null, string | null, string | null, string | null];
const VERSION_KEY = "meta-index-version";
export const LISTING_PREFIX = "meta:";

/** Explicitly called by each relevant writer, inside its existing transaction. */
export function refreshListingRow(tx: StorageTx, id: string): void {
  const row: ListingRow = [
    tx.get(metaKey(id)),
    tx.get(modelKey(id)),
    tx.get(parentKey(id)),
    tx.get(tabGroupParentKey(id)),
  ];
  tx.set(`${LISTING_PREFIX}${id}`, JSON.stringify(row));
}

/** Lists retain the cheap version check; activation validates even an existing index. */
async function ensureConversationListIndex(storage: StorageNamespace): Promise<void> {
  if ((await storage.get(VERSION_KEY)) === "1") return;
  await storage.transaction((tx) => {
    if (tx.get(VERSION_KEY) === "1") return;
    const rows = new Map<string, [string | null, string | null, string | null, string | null]>();
    for (const [key, value] of tx.entries("conv:")) {
      const match = /^conv:([\s\S]*):(meta|model|parent|tab-group-parent)$/.exec(key);
      const id = match?.[1];
      const field = match?.[2];
      if (id === undefined || field === undefined) continue;
      const row = rows.get(id) ?? [null, null, null, null];
      row[field === "meta" ? 0 : field === "model" ? 1 : field === "parent" ? 2 : 3] = value;
      rows.set(id, row);
    }
    for (const [key] of tx.entries(LISTING_PREFIX)) tx.delete(key);
    for (const [id, row] of rows) tx.set(`${LISTING_PREFIX}${id}`, JSON.stringify(row));
    tx.set(VERSION_KEY, "1");
  });
}

function validationIds(
  rawIndex: string | null,
  listings: ReadonlyMap<string, string>,
): Set<string> {
  const ids = new Set([...listings.keys()].map((key) => key.slice(LISTING_PREFIX.length)));
  try {
    const parsed: unknown = JSON.parse(rawIndex ?? "[]");
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === "string") ids.add(id);
    }
  } catch {
    // Malformed canonical indexes retain the existing empty-list semantics.
  }
  return ids;
}

function serializedRow(row: ListingRow): string | null {
  return row.every((value) => value === null) ? null : JSON.stringify(row);
}

/** Validate at every activation, before the status sweep. Four bounded canonical
 * reads per known id, never history/metrics scans. Clean indexes need no writes
 * or write transaction. Old writers must be quiescent during activation; this is
 * not a live multi-binary coherence protocol. Repair rechecks inside its tx so a
 * current writer that committed during validation cannot be overwritten by a
 * stale validation snapshot. Failures roll back and the next activation retries.
 */
export async function initializeConversationListIndex(storage: StorageNamespace): Promise<void> {
  await ensureConversationListIndex(storage);
  const listings = new Map(await storage.entries(LISTING_PREFIX));
  const ids = validationIds(await storage.get(CONVERSATION_INDEX_KEY), listings);
  let drift = false;
  for (const id of ids) {
    const row: ListingRow = [
      await storage.get(metaKey(id)),
      await storage.get(modelKey(id)),
      await storage.get(parentKey(id)),
      await storage.get(tabGroupParentKey(id)),
    ];
    if ((listings.get(`${LISTING_PREFIX}${id}`) ?? null) !== serializedRow(row)) {
      drift = true;
      break;
    }
  }
  if (!drift) return;
  await storage.transaction((tx) => {
    const current = new Map(tx.entries(LISTING_PREFIX));
    for (const id of validationIds(tx.get(CONVERSATION_INDEX_KEY), current)) {
      const key = `${LISTING_PREFIX}${id}`;
      const expected = serializedRow([
        tx.get(metaKey(id)),
        tx.get(modelKey(id)),
        tx.get(parentKey(id)),
        tx.get(tabGroupParentKey(id)),
      ]);
      if ((current.get(key) ?? null) === expected) continue;
      if (expected === null) tx.delete(key);
      else tx.set(key, expected);
    }
  });
}

export async function readListingRows(storage: StorageNamespace): Promise<Map<string, ListingRow>> {
  await ensureConversationListIndex(storage);
  const rows = new Map<string, ListingRow>();
  for (const [key, value] of await storage.entries(LISTING_PREFIX)) {
    rows.set(key.slice(LISTING_PREFIX.length), JSON.parse(value) as ListingRow);
  }
  return rows;
}
