import { describe, expect, it } from "vitest";
import { type AggregateServer, aggregateDiagnostics } from "./aggregate.js";
import type { LanguageServerClient } from "./client.js";

/**
 * A minimal fake client: only `waitForDiagnostics` is exercised by
 * aggregateDiagnostics, so we stub just that. Cast to the real type (mirrors
 * tool.test.ts) — no real process, no internal mocks of our own modules.
 */
function fakeClient(
  waitForDiagnostics: LanguageServerClient["waitForDiagnostics"],
): LanguageServerClient {
  return { waitForDiagnostics } as unknown as LanguageServerClient;
}

const SERVER_A: AggregateServer = { id: "a", name: "Ruby-LSP", root: "/p" };
const SERVER_B: AggregateServer = { id: "b", name: "Steep", root: "/p" };

describe("aggregateDiagnostics", () => {
  it("returns merged diagnostics from all responding servers, tagged by source", async () => {
    const clients = new Map<string, LanguageServerClient>([
      [
        "a",
        fakeClient(async () => ({ formatted: "ERROR L1:1: boom", slow: false, timedOut: false })),
      ],
      [
        "b",
        fakeClient(async () => ({ formatted: "WARNING L2:3: meh", slow: false, timedOut: false })),
      ],
    ]);

    const result = await aggregateDiagnostics(
      (id) => clients.get(id),
      [SERVER_A, SERVER_B],
      "/p/x.rb",
      10_000,
      {},
    );

    expect(result.timedOut).toBe(false);
    expect(result.formatted).toContain("[Ruby-LSP]");
    expect(result.formatted).toContain("boom");
    expect(result.formatted).toContain("[Steep]");
    expect(result.formatted).toContain("meh");
  });

  it("skips a server that times out with a raise-to-user notice, and still returns the fast server's result", async () => {
    // Steep never resolves within the cap → timedOut; ruby-lsp answers fast.
    const clients = new Map<string, LanguageServerClient>([
      ["a", fakeClient(async () => ({ formatted: "", slow: false, timedOut: false }))],
      ["b", fakeClient(async () => ({ formatted: "", slow: false, timedOut: true }))],
    ]);

    const result = await aggregateDiagnostics(
      (id) => clients.get(id),
      [SERVER_A, SERVER_B],
      "/p/x.rb",
      10_000,
      {},
    );

    expect(result.timedOut).toBe(true);
    // The skip notice names the offending server and the cap.
    expect(result.formatted).toContain("[Steep]");
    expect(result.formatted).toContain("took too long");
    expect(result.formatted).toContain(">10s");
    expect(result.formatted).toContain("raise this to the user");
    // ruby-lsp answered cleanly (empty diagnostics) → no line for it.
    expect(result.formatted).not.toContain("[Ruby-LSP]");
  });

  it("runs servers concurrently: a slow server does not delay a fast one's contribution order", async () => {
    const callOrder: string[] = [];
    const clients = new Map<string, LanguageServerClient>([
      [
        "a",
        fakeClient(async () => {
          callOrder.push("a-start");
          await new Promise((r) => setTimeout(r, 5));
          callOrder.push("a-end");
          return { formatted: "from-a", slow: false, timedOut: false };
        }),
      ],
      [
        "b",
        fakeClient(async () => {
          callOrder.push("b-start");
          await new Promise((r) => setTimeout(r, 30));
          callOrder.push("b-end");
          return { formatted: "from-b", slow: false, timedOut: false };
        }),
      ],
    ]);

    const result = await aggregateDiagnostics(
      (id) => clients.get(id),
      [SERVER_A, SERVER_B],
      "/p/x.rb",
      10_000,
      {},
    );

    // Both started before either ended → concurrent, not sequential.
    expect(callOrder.slice(0, 2).sort()).toEqual(["a-start", "b-start"]);
    expect(result.formatted).toContain("from-a");
    expect(result.formatted).toContain("from-b");
  });

  it("a missing client (dead/excluded) contributes nothing and never rejects", async () => {
    const result = await aggregateDiagnostics(() => undefined, [SERVER_A], "/p/x.rb", 10_000, {});
    expect(result.formatted).toBe("");
    expect(result.timedOut).toBe(false);
  });

  it("forwards text + minSeverity to each client's waitForDiagnostics", async () => {
    const seen: Array<{ text?: string; minSeverity?: number; timeoutMs: number }> = [];
    const clients = new Map<string, LanguageServerClient>([
      [
        "a",
        fakeClient(async (_path, opts) => {
          seen.push({
            text: opts?.text,
            minSeverity: opts?.minSeverity,
            timeoutMs: opts?.timeoutMs ?? -1,
          });
          return { formatted: "", slow: false, timedOut: false };
        }),
      ],
    ]);

    await aggregateDiagnostics((id) => clients.get(id), [SERVER_A], "/p/x.rb", 7000, {
      text: "post-edit buffer",
      minSeverity: 2,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe("post-edit buffer");
    expect(seen[0]?.minSeverity).toBe(2);
    expect(seen[0]?.timeoutMs).toBe(7000);
  });
});
