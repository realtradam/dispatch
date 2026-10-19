import type { Logger, StorageNamespace } from "@dispatch/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import {
  hashImageUrl,
  imageTranscriptionKey,
  imageTranscriptionPrefix,
  legacyImageTranscriptionsKey,
} from "./keys.js";
import { createConversationStore } from "./store.js";

/**
 * In-memory storage backend with call instrumentation. Tests assert the
 * per-image cache does ONLY the I/O it must: one `set` per transcription and
 * one `get` per requested URL (never a whole-blob read-modify-write).
 */
function createMemoryStorage(): {
  storage: StorageNamespace;
  data: Map<string, string>;
  gets: string[];
  sets: string[];
} {
  const data = new Map<string, string>();
  const gets: string[] = [];
  const sets: string[] = [];
  const storage: StorageNamespace = {
    get: async (key) => {
      gets.push(key);
      return data.get(key) ?? null;
    },
    set: async (key, value) => {
      sets.push(key);
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
    has: async (key) => data.has(key),
    keys: async (prefix) => {
      const all = [...data.keys()];
      if (!prefix) return all;
      return all.filter((k) => k.startsWith(prefix));
    },
  };
  return { storage, data, gets, sets };
}

function createLogger(): { logger: Logger; warns: { msg: string; attrs?: unknown }[] } {
  const warns: { msg: string; attrs?: unknown }[] = [];
  const make = (): Logger => ({
    debug: () => {},
    info: () => {},
    warn: (msg, attrs) => {
      warns.push({ msg, attrs });
    },
    error: () => {},
    child: () => make(),
    span: () => ({
      id: "span",
      log: make(),
      setAttributes: () => {},
      addLink: () => {},
      child: () => make().span("child"),
      end: () => {},
    }),
  });
  return { logger: make(), warns };
}

describe("ConversationStore image transcription cache", () => {
  let memory: ReturnType<typeof createMemoryStorage>;
  let store: ReturnType<typeof createConversationStore>;

  beforeEach(() => {
    memory = createMemoryStorage();
    store = createConversationStore(memory.storage);
  });

  it("round-trips a transcription by persisted URL", async () => {
    const url = "/images/conv-1/img-a.png";
    await store.setImageTranscription("conv-1", url, "a red square");

    const got = await store.getImageTranscriptions("conv-1", [url]);
    expect(got.get(url)).toBe("a red square");
    expect(got.size).toBe(1);
  });

  it("stores each transcription under sha256(persisted URL), not the URL itself", async () => {
    const url = "data:image/png;base64,AAAA";
    await store.setImageTranscription("conv-1", url, "legacy inline image");

    const key = imageTranscriptionKey("conv-1", url);
    expect(key).toBe(`conv:conv-1:image-transcription:${hashImageUrl(url)}`);
    expect(key).toContain(hashImageUrl(url));
    expect(key).not.toContain(url);
    expect(memory.data.get(key)).toBe("legacy inline image");
  });

  it("get with a subset of URLs returns only those, reading one row each", async () => {
    await store.setImageTranscription("conv-1", "/images/conv-1/a.png", "A");
    await store.setImageTranscription("conv-1", "/images/conv-1/b.png", "B");
    await store.setImageTranscription("conv-1", "/images/conv-1/c.png", "C");
    memory.gets.length = 0;

    const got = await store.getImageTranscriptions("conv-1", [
      "/images/conv-1/a.png",
      "/images/conv-1/c.png",
    ]);

    expect([...got.entries()].sort()).toEqual([
      ["/images/conv-1/a.png", "A"],
      ["/images/conv-1/c.png", "C"],
    ]);
    // One get per requested URL — b.png was never read.
    expect(memory.gets).toEqual([
      imageTranscriptionKey("conv-1", "/images/conv-1/a.png"),
      imageTranscriptionKey("conv-1", "/images/conv-1/c.png"),
    ]);
  });

  it("de-duplicates repeated URLs in one get", async () => {
    await store.setImageTranscription("conv-1", "/images/conv-1/a.png", "A");
    memory.gets.length = 0;

    const got = await store.getImageTranscriptions("conv-1", [
      "/images/conv-1/a.png",
      "/images/conv-1/a.png",
    ]);
    expect(got.size).toBe(1);
    expect(memory.gets).toHaveLength(1);
  });

  it("returns an empty map for cache misses and unknown conversations", async () => {
    expect((await store.getImageTranscriptions("nope", ["/images/nope/x.png"])).size).toBe(0);
  });

  it("set is a SINGLE row write with NO read (no read-modify-write)", async () => {
    await store.setImageTranscription("conv-1", "/images/conv-1/a.png", "A");
    memory.gets.length = 0;
    memory.sets.length = 0;

    await store.setImageTranscription("conv-1", "/images/conv-1/b.png", "B");

    expect(memory.gets).toEqual([]);
    expect(memory.sets).toEqual([imageTranscriptionKey("conv-1", "/images/conv-1/b.png")]);
  });

  it("keeps new keys isolated from the legacy transcription key", async () => {
    // A legacy blob exists; the runtime cache must not see it.
    await memory.storage.set(
      legacyImageTranscriptionsKey("conv-1"),
      JSON.stringify({ "data:image/png;base64,OLD": "old text" }),
    );
    await store.setImageTranscription("conv-1", "/images/conv-1/a.png", "new text");

    const got = await store.getImageTranscriptions("conv-1", [
      "data:image/png;base64,OLD",
      "/images/conv-1/a.png",
    ]);
    expect(got.get("/images/conv-1/a.png")).toBe("new text");
    // The legacy data-URL entry was NOT served from the legacy blob.
    expect(got.has("data:image/png;base64,OLD")).toBe(false);

    // Prefix scans do not cross-match: the legacy key is not under the new
    // per-image prefix, and the new row is not the legacy key.
    const newKeys = await memory.storage.keys(imageTranscriptionPrefix("conv-1"));
    expect(newKeys).toEqual([imageTranscriptionKey("conv-1", "/images/conv-1/a.png")]);
    expect(newKeys).not.toContain(legacyImageTranscriptionsKey("conv-1"));
  });
});

describe("ConversationStore.deleteConversation image transcriptions", () => {
  it("removes every per-image row and the legacy blob", async () => {
    const memory = createMemoryStorage();
    const store = createConversationStore(memory.storage);
    await store.setImageTranscription("conv-1", "/images/conv-1/a.png", "A");
    await store.setImageTranscription("conv-1", "/images/conv-1/b.png", "B");
    await memory.storage.set(legacyImageTranscriptionsKey("conv-1"), JSON.stringify({ x: "y" }));
    // An unrelated conversation's row must survive.
    await store.setImageTranscription("conv-2", "/images/conv-2/c.png", "C");

    await store.deleteConversation("conv-1");

    expect(await memory.storage.keys(imageTranscriptionPrefix("conv-1"))).toEqual([]);
    expect(memory.data.has(legacyImageTranscriptionsKey("conv-1"))).toBe(false);
    expect(await store.getImageTranscriptions("conv-2", ["/images/conv-2/c.png"])).toEqual(
      new Map([["/images/conv-2/c.png", "C"]]),
    );
  });
});

describe("ConversationStore.migrateImageTranscriptions", () => {
  const legacyUrlA = "data:image/png;base64,AAA";
  const legacyUrlB = "/images/conv-1/b.png";

  it("converts a legacy blob into per-image rows keyed by sha256(url)", async () => {
    const memory = createMemoryStorage();
    const store = createConversationStore(memory.storage);
    await memory.storage.set(
      legacyImageTranscriptionsKey("conv-1"),
      JSON.stringify({ [legacyUrlA]: "text A", [legacyUrlB]: "text B" }),
    );

    const report = await store.migrateImageTranscriptions();

    expect(report).toEqual({ blobs: 1, migrated: 2, skipped: 0 });
    expect(memory.data.get(imageTranscriptionKey("conv-1", legacyUrlA))).toBe("text A");
    expect(memory.data.get(imageTranscriptionKey("conv-1", legacyUrlB))).toBe("text B");
    expect(memory.data.has(legacyImageTranscriptionsKey("conv-1"))).toBe(false);
    // The runtime reads them back.
    expect(await store.getImageTranscriptions("conv-1", [legacyUrlA, legacyUrlB])).toEqual(
      new Map([
        [legacyUrlA, "text A"],
        [legacyUrlB, "text B"],
      ]),
    );
  });

  it("is idempotent: a second run is a no-op", async () => {
    const memory = createMemoryStorage();
    const store = createConversationStore(memory.storage);
    await memory.storage.set(
      legacyImageTranscriptionsKey("conv-1"),
      JSON.stringify({ [legacyUrlA]: "text A" }),
    );

    const first = await store.migrateImageTranscriptions();
    const second = await store.migrateImageTranscriptions();

    expect(first).toEqual({ blobs: 1, migrated: 1, skipped: 0 });
    expect(second).toEqual({ blobs: 0, migrated: 0, skipped: 0 });
    expect(memory.data.get(imageTranscriptionKey("conv-1", legacyUrlA))).toBe("text A");
  });

  it("leaves unrelated conversations' legacy blobs alone in the same pass", async () => {
    const memory = createMemoryStorage();
    const store = createConversationStore(memory.storage);
    await memory.storage.set(legacyImageTranscriptionsKey("a"), JSON.stringify({ u1: "one" }));
    await memory.storage.set(legacyImageTranscriptionsKey("b"), JSON.stringify({ u2: "two" }));

    const report = await store.migrateImageTranscriptions();

    expect(report).toEqual({ blobs: 2, migrated: 2, skipped: 0 });
    expect(memory.data.get(imageTranscriptionKey("a", "u1"))).toBe("one");
    expect(memory.data.get(imageTranscriptionKey("b", "u2"))).toBe("two");
  });

  it("skips entries with non-string values and empty URLs", async () => {
    const memory = createMemoryStorage();
    const store = createConversationStore(memory.storage);
    await memory.storage.set(
      legacyImageTranscriptionsKey("conv-1"),
      JSON.stringify({ good: "text", bad: 42, "": "empty key" }),
    );

    const report = await store.migrateImageTranscriptions();

    expect(report).toEqual({ blobs: 1, migrated: 1, skipped: 0 });
    expect(memory.data.get(imageTranscriptionKey("conv-1", "good"))).toBe("text");
  });

  it("handles a malformed blob: logs, skips, never throws, leaves the key", async () => {
    const memory = createMemoryStorage();
    const { logger, warns } = createLogger();
    const store = createConversationStore(memory.storage, logger);
    await memory.storage.set(legacyImageTranscriptionsKey("conv-1"), "{not json");

    const report = await store.migrateImageTranscriptions();

    expect(report).toEqual({ blobs: 0, migrated: 0, skipped: 1 });
    expect(warns.some((w) => w.msg.includes("malformed legacy image-transcription"))).toBe(true);
    // Non-destructive: the unreadable blob is left in place.
    expect(memory.data.has(legacyImageTranscriptionsKey("conv-1"))).toBe(true);
  });

  it("handles a non-object JSON blob (array) as malformed", async () => {
    const memory = createMemoryStorage();
    const { logger, warns } = createLogger();
    const store = createConversationStore(memory.storage, logger);
    await memory.storage.set(legacyImageTranscriptionsKey("conv-1"), JSON.stringify(["x"]));

    const report = await store.migrateImageTranscriptions();

    expect(report).toEqual({ blobs: 0, migrated: 0, skipped: 1 });
    expect(warns).toHaveLength(1);
  });

  it("is a no-op on a database with no legacy blobs", async () => {
    const memory = createMemoryStorage();
    const store = createConversationStore(memory.storage);
    await store.setImageTranscription("conv-1", "u", "t");

    expect(await store.migrateImageTranscriptions()).toEqual({
      blobs: 0,
      migrated: 0,
      skipped: 0,
    });
    expect(await store.getImageTranscriptions("conv-1", ["u"])).toEqual(new Map([["u", "t"]]));
  });
});
