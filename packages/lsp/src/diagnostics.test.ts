import { describe, expect, it } from "vitest";
import { DiagnosticsStore } from "./diagnostics.js";

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
});
