import type { StorageNamespace } from "@dispatch/kernel";
import { metaKey, modelKey, parentKey, tabGroupParentKey } from "./keys.js";

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

/** One atomic, idempotent bootstrap. Safe to retry after failure or await at activation.
 * A completed index needs no writes, including for read-only steady-state adapters.
 */
export async function initializeConversationListIndex(storage: StorageNamespace): Promise<void> {
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

export async function readListingRows(storage: StorageNamespace): Promise<Map<string, ListingRow>> {
  await initializeConversationListIndex(storage);
  const rows = new Map<string, ListingRow>();
  for (const [key, value] of await storage.entries(LISTING_PREFIX)) {
    rows.set(key.slice(LISTING_PREFIX.length), JSON.parse(value) as ListingRow);
  }
  return rows;
}
