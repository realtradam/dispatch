import { describe, expect, it } from "vitest";
import { type Diagnostic, DiagnosticsStore } from "./diagnostics.js";

describe("diagnostics", () => {
  it("formats diagnostics with severity, location, and message", () => {
    const store = new DiagnosticsStore();
    store.setPushDiagnostics({
      uri: "file:///test.ts",
      diagnostics: [
        {
          range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
          severity: 1,
          source: "typescript",
          message: "Cannot find name 'hello'.",
        },
      ],
    });

    const formatted = store.format("file:///test.ts");
    expect(formatted).toContain("ERROR");
    expect(formatted).toContain("L1:6");
    expect(formatted).toContain("Cannot find name 'hello'.");
    expect(formatted).toContain("[typescript]");
  });

  it("merges push and pull diagnostics with deduplication", () => {
    const store = new DiagnosticsStore();
    const diag = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      message: "Error",
    };

    store.setPushDiagnostics({
      uri: "file:///test.ts",
      diagnostics: [diag],
    });
    store.setPullDiagnostics("file:///test.ts", {
      kind: "full",
      items: [diag],
    });

    const merged = store.getMerged("file:///test.ts");
    expect(merged).toHaveLength(1);
  });

  it("returns empty string when no diagnostics exist", () => {
    const store = new DiagnosticsStore();
    expect(store.format("file:///nonexistent.ts")).toBe("");
  });

  it("purge drops push diagnostics, pull diagnostics, and the received flag (Bug 3)", () => {
    const store = new DiagnosticsStore();
    store.setPushDiagnostics({
      uri: "file:///project/a.ts",
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message: "boom",
        },
      ],
    });
    store.setPullDiagnostics("file:///project/a.ts", {
      kind: "full",
      items: [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          severity: 2,
          message: "warn",
        },
      ],
    });
    expect(store.hasReceivedPush("file:///project/a.ts")).toBe(true);
    expect(store.format("file:///project/a.ts")).toContain("boom");

    store.purge("file:///project/a.ts");

    // Everything for that URI is gone — the store no longer retains it.
    expect(store.hasReceivedPush("file:///project/a.ts")).toBe(false);
    expect(store.format("file:///project/a.ts")).toBe("");
    expect(store.getMerged("file:///project/a.ts")).toHaveLength(0);

    // Other URIs are untouched.
    expect(store.format("file:///project/b.ts")).toBe("");
  });

  it("bounds pushDiagnostics — oldest background file is evicted past the cap (Bug 3 remainder)", () => {
    // Language servers scan the workspace and push diagnostics for files the
    // agent never opened. These never enter the client's openDocuments LRU,
    // so without an independent cap the pushDiagnostics map grows forever.
    const store = new DiagnosticsStore();
    const CAP = 100;

    const diag = (uri: string): readonly Diagnostic[] => [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        message: `err in ${uri}`,
      },
    ];

    // Push `CAP` distinct background files (at the cap — none evicted yet).
    for (let i = 0; i < CAP; i++) {
      store.setPushDiagnostics({ uri: `file:///bg/file${i}.ts`, diagnostics: diag(`file${i}`) });
    }
    expect(store.hasReceivedPush("file:///bg/file0.ts")).toBe(true);
    expect(store.format("file:///bg/file0.ts")).toContain("err in file0");

    // One past the cap → the least-recently-pushed (file0) is evicted.
    store.setPushDiagnostics({
      uri: "file:///bg/file100.ts",
      diagnostics: diag("file100"),
    });

    // file0 (oldest) is gone — no didClose, no retained diagnostics, no flag.
    expect(store.hasReceivedPush("file:///bg/file0.ts")).toBe(false);
    expect(store.format("file:///bg/file0.ts")).toBe("");
    expect(store.getMerged("file:///bg/file0.ts")).toHaveLength(0);

    // The newest (file100) and a middle entry are retained.
    expect(store.hasReceivedPush("file:///bg/file100.ts")).toBe(true);
    expect(store.format("file:///bg/file100.ts")).toContain("err in file100");
    expect(store.format("file:///bg/file50.ts")).toContain("err in file50");
  });

  it("re-pushing a URI refreshes its LRU position so it is not evicted", () => {
    const store = new DiagnosticsStore();
    const CAP = 100;

    const diag = (uri: string): readonly Diagnostic[] => [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        message: uri,
      },
    ];

    for (let i = 0; i < CAP; i++) {
      store.setPushDiagnostics({ uri: `file:///bg/file${i}.ts`, diagnostics: diag(`file${i}`) });
    }

    // Re-push file0 (an actively-edited file gets re-pushed on each change):
    // this should move it to the tail (most-recently-used), NOT leave it at
    // the head where it would be the first eviction candidate.
    store.setPushDiagnostics({ uri: "file:///bg/file0.ts", diagnostics: diag("file0-updated") });

    // Now push one past the cap. file1 (now the oldest untouched) should be
    // evicted; file0 (refreshed) must survive.
    store.setPushDiagnostics({ uri: "file:///bg/file100.ts", diagnostics: diag("file100") });

    expect(store.hasReceivedPush("file:///bg/file0.ts")).toBe(true);
    expect(store.format("file:///bg/file0.ts")).toContain("file0-updated");

    expect(store.hasReceivedPush("file:///bg/file1.ts")).toBe(false);
    expect(store.format("file:///bg/file1.ts")).toBe("");
  });
});
