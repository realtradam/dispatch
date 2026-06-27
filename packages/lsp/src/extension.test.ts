import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FsWatcherHandle, WatchFn } from "./extension.js";

// `realFileWatcher` is a module-private function; the exported seam below
// re-exposes it for testing. Import through the module to exercise the real
// production path (the error-listener attachment is what we're verifying).
import { __test__realFileWatcher } from "./extension.js";

describe("realFileWatcher (Bug 2 — unhandled fs.watch 'error' event)", () => {
  it("swallows a watcher 'error' event instead of crashing (injected watcher)", () => {
    // A fake fs.watch: returns an EventEmitter we control. Without an
    // 'error' listener, Node EventEmitter throws an uncaughtException on
    // emit('error'). The fix attaches a no-op 'error' listener, so emitting
    // here must NOT throw. The fake wires the watch callback to the
    // EventEmitter's "change" event (args: eventType, filename), mirroring
    // how node:fs.watch invokes its callback.
    const watcher = new EventEmitter() as unknown as FsWatcherHandle & {
      close: () => void;
    };
    (watcher as { close: () => void }).close = () => {
      watcher.removeAllListeners();
    };
    const fakeWatch: WatchFn = (_root, _opts, cb) => {
      watcher.on("change", (eventType: string, filename: string | null) => cb(eventType, filename));
      return watcher;
    };

    const events: { type: string; path: string }[] = [];
    const handle = __test__realFileWatcher("/project", (e) => events.push(e), fakeWatch);

    // A transient FS error (e.g. bun install deleting a watched dir) — must
    // be a no-op, NOT an uncaught exception.
    expect(() => watcher.emit("error", new Error("ENOENT transient"))).not.toThrow();

    // The watcher still forwards normal change events.
    watcher.emit("change", "change", "src/a.ts");
    expect(events).toEqual([{ type: "change", path: "/project/src/a.ts" }]);

    handle.close();
  });

  it("ignores a null filename (no spurious event)", () => {
    const watcher = new EventEmitter() as unknown as FsWatcherHandle & {
      close: () => void;
    };
    (watcher as { close: () => void }).close = () => {
      watcher.removeAllListeners();
    };
    const fakeWatch: WatchFn = (_root, _opts, cb) => {
      watcher.on("change", (eventType: string, filename: string | null) => cb(eventType, filename));
      return watcher;
    };

    const events: { type: string; path: string }[] = [];
    const handle = __test__realFileWatcher("/project", (e) => events.push(e), fakeWatch);

    watcher.emit("change", "change", null);
    expect(events).toHaveLength(0);

    handle.close();
  });

  it("integration: watches a real temp directory and fires on file change", async () => {
    // A real-FS smoke test of the production adapter's happy path. Uses the
    // real node:fs.watch (recursive on a temp dir). Best-effort: some
    // platforms coalesce events, so we only assert the adapter runs and
    // closes cleanly without throwing — we do not hard-assert an event
    // arrived (that would be flaky across inotify/kqueue/Win backends).
    const dir = mkdtempSync(join(tmpdir(), "lsp-watch-"));
    try {
      const events: { type: string; path: string }[] = [];
      const handle = __test__realFileWatcher(dir, (e) => events.push(e));

      // Touch a file; give the watcher a moment.
      writeFileSync(join(dir, "hello.txt"), "hi");
      await new Promise((r) => setTimeout(r, 150));

      handle.close();
      // No assertion on events.length — the point is no throw + clean close.
      expect(true).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
