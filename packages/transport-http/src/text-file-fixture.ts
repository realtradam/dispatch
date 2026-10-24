import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "@dispatch/conversation-store";
import type { StorageNamespace } from "@dispatch/kernel";

type StorageEntriesOptions = Parameters<StorageNamespace["entries"]>[1];

import { createApp } from "./app.js";

/** Real store + real app, with only the outer persistence edge in memory. */
export async function createTextFileFixture() {
  const root = await mkdtemp(join(tmpdir(), "dispatch-text-files-"));
  const data = new Map<string, string>();
  const entries = (prefix: string, options?: StorageEntriesOptions) => {
    let rows = [...data.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .filter(([key]) => options?.startAfter === undefined || key > options.startAfter)
      .filter(([key]) => options?.endBefore === undefined || key < options.endBefore)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (options?.reverse) rows = rows.reverse();
    if (options?.limit !== undefined) rows = rows.slice(0, options.limit);
    return rows;
  };
  const storage: StorageNamespace = {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
    has: async (key) => data.has(key),
    keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix ?? "")),
    entries: async (prefix, options) => entries(prefix, options),
    count: async (prefix) => entries(prefix).length,
    transaction: async (fn) => {
      const snapshot = new Map(data);
      try {
        return fn({
          get: (key) => data.get(key) ?? null,
          set: (key, value) => {
            data.set(key, value);
          },
          delete: (key) => {
            data.delete(key);
          },
          entries,
        });
      } catch (error) {
        data.clear();
        for (const [key, value] of snapshot) data.set(key, value);
        throw error;
      }
    },
  };
  const store = createConversationStore(storage);
  await store.ensureWorkspace("files", { defaultCwd: root });
  await store.setWorkspaceId("local", "files");
  await store.setWorkspaceId("remote", "files");
  await store.setComputerId("remote", "remote-test");
  const path = join(root, "plan 100%.md");
  const text =
    "# Saved plan\n\nThis document was fetched from a real HTTP transport.\n\n- Save the plan\n- Embed the file\n";
  await writeFile(path, text);
  const app = createApp({
    conversationStore: store,
    // File routes never invoke these unrelated services.
    orchestrator: {} as Parameters<typeof createApp>[0]["orchestrator"],
    credentialStore: {} as Parameters<typeof createApp>[0]["credentialStore"],
  });
  return {
    app,
    store,
    root,
    path,
    text,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
