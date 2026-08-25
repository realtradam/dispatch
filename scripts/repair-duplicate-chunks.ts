/**
 * scripts/repair-duplicate-chunks.ts — one-shot, idempotent repair of a
 * conversation transcript that contains DUPLICATE tool-call/tool-result
 * chunks (same `toolCallId` persisted twice — the provider double-emission
 * bug fixed in the kernel; see notes/fix-toolcall-duplicate-keys-plan.md
 * Part 3).
 *
 * Such duplicates:
 *   - crash the frontend tab (Svelte `each_key_duplicate` — the keyed
 *     `{#each row.group.entries as entry (entry.call.toolCallId)}` throws),
 *   - and corrupt the provider prompt on future turns (the backend `load()`
 *     returns the duplicates to the model).
 *
 * The repair loads the conversation's reconciled messages, drops every
 * duplicate tool-call / tool-result chunk after the FIRST occurrence of its
 * `toolCallId`, and rewrites the history via `store.replaceHistory` (which
 * deletes + re-numbers the chunks, preserving metadata like title/status/
 * model/cwd). Idempotent: a second run finds nothing to remove and reports a
 * no-op (replaceHistory is NOT called when nothing changed).
 *
 * Usage (run from the backend repo, with the service STOPPED to avoid write
 * contention on the SQLite DB — SQLite WAL serializes writers):
 *
 *   DISPATCH_DB=/var/lib/dispatch/dispatch.db bun scripts/repair-duplicate-chunks.ts <conversationId>
 *
 * No argument = scan every conversation (report-only unless --fix is passed).
 * --fix applies repairs; without it the script only REPORTS what it would do.
 *
 * Deps: bun (runs TS directly) + the repo's packages (file: deps resolved).
 */

import {
  countChunks,
  dedupeDuplicateToolChunks,
} from "../packages/conversation-store/src/repair.js";
import { createConversationStore } from "../packages/conversation-store/src/store.js";
import { createSqliteStorage } from "../packages/storage-sqlite/src/storage.js";

const DB_PATH = process.env.DISPATCH_DB ?? "./.dispatch-data/dispatch.db";
const args = process.argv.slice(2);
const FIX = args.includes("--fix");
const TARGET = args.find((a) => !a.startsWith("--"));

const logger = {
  info(msg: string, attrs?: Record<string, unknown>): void {
    console.log(`[repair] ${msg}${attrs !== undefined ? ` ${JSON.stringify(attrs)}` : ""}`);
  },
  warn(msg: string, attrs?: Record<string, unknown>): void {
    console.warn(`[repair] WARN ${msg}${attrs !== undefined ? ` ${JSON.stringify(attrs)}` : ""}`);
  },
  error(msg: string, attrs?: Record<string, unknown>): void {
    console.error(`[repair] ERROR ${msg}${attrs !== undefined ? ` ${JSON.stringify(attrs)}` : ""}`);
  },
} as Parameters<typeof createConversationStore>[1];

async function main(): Promise<void> {
  const sqlite = createSqliteStorage({ path: DB_PATH });
  const storage = sqlite.storage("conversation-store");
  const store = createConversationStore(storage, logger);

  // Resolve the target conversation(s): explicit id, or the full index.
  let ids: string[];
  if (TARGET !== undefined) {
    ids = [TARGET];
  } else {
    const all = await store.listConversations({ status: ["active", "idle", "closed"] });
    ids = all.map((m) => m.id);
    logger.info(
      `no target given — scanning ${ids.length} conversations (report-only unless --fix)`,
    );
  }

  for (const id of ids) {
    const messages = await store.load(id);
    const beforeChunks = countChunks(messages);

    if (beforeChunks === 0) {
      logger.info(`conversation ${id}: empty — skipping`);
      continue;
    }

    const { messages: deduped, removedChunks, removedIds } = dedupeDuplicateToolChunks(messages);
    const afterChunks = beforeChunks - removedChunks;

    if (removedChunks === 0) {
      logger.info(`conversation ${id}: clean (${beforeChunks} chunks) — no repair needed`);
      continue;
    }

    logger.info(
      `conversation ${id}: ${removedChunks} duplicate chunk(s) to remove (${beforeChunks} → ${afterChunks}); ids: [${removedIds.join(", ")}]`,
    );

    if (FIX) {
      await store.replaceHistory(id, deduped);
      logger.info(`conversation ${id}: repaired — history rewritten (${afterChunks} chunks)`);
    } else {
      logger.info(`conversation ${id}: NOT applied — re-run with --fix to repair`);
    }
  }

  sqlite.close?.();
  console.log(FIX ? "[repair] done (fix applied)." : "[repair] done (report only).");
}

main().catch((err) => {
  console.error("[repair] fatal:", err);
  process.exit(1);
});
