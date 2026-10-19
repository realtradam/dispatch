import type { ToolExecuteContext } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { type CheckOutcome, type CheckRunner, DiagnosticsCheckQueue } from "./check-queue.js";
import type { Diagnostic } from "./diagnostics.js";
import type { LspManager } from "./manager.js";
import { createLspTool } from "./tool.js";

function stubManager(overrides?: Partial<LspManager>): LspManager {
  return {
    status: async () => [],
    getClient: () => undefined,
    shutdownAll: () => {},
    ...overrides,
  } as unknown as LspManager;
}

describe("tool", () => {
  it("diagnostics formats errors", async () => {
    const tool = createLspTool(stubManager());
    const result = await tool.execute(
      { operation: "diagnostics", path: "test.ts" },
      {
        toolCallId: "test",
        onOutput: () => {},
        signal: AbortSignal.timeout(5000),
        log: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({}) as never,
          span: () => ({}) as never,
        },
        cwd: "/project",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No language server configured");
  });

  it("position ops convert 1-based to 0-based", async () => {
    let receivedPosition: { line: number; character: number } | null = null;

    const mockClient = {
      getState: () => "connected" as const,
      getStateError: () => undefined,
      request: async (method: string, params: unknown) => {
        if (method === "textDocument/hover") {
          receivedPosition = (params as { position: { line: number; character: number } }).position;
          return { contents: { value: "hover result" } };
        }
        return null;
      },
      waitForDiagnostics: async () => "",
    };

    const tool = createLspTool(
      stubManager({
        status: async () => [
          {
            id: "ts",
            name: "TypeScript",
            root: "/project",
            extensions: [".ts"],
            state: "connected",
          },
        ],
        getClient: () => mockClient as never,
      }),
    );

    const result = await tool.execute(
      { operation: "hover", path: "test.ts", line: 5, character: 10 },
      {
        toolCallId: "test",
        onOutput: () => {},
        signal: AbortSignal.timeout(5000),
        log: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({}) as never,
          span: () => ({}) as never,
        },
        cwd: "/project",
      },
    );

    expect(receivedPosition).toEqual({ line: 4, character: 9 });
    expect(result.content).toBe("hover result");
  });

  it("path resolved against ctx.cwd", async () => {
    let receivedUri: string | null = null;

    const mockClient = {
      getState: () => "connected" as const,
      getStateError: () => undefined,
      request: async (method: string, params: unknown) => {
        if (method === "textDocument/hover") {
          receivedUri = (params as { textDocument: { uri: string } }).textDocument.uri;
          return { contents: { value: "ok" } };
        }
        return null;
      },
      waitForDiagnostics: async () => "",
    };

    const tool = createLspTool(
      stubManager({
        status: async () => [
          {
            id: "ts",
            name: "TypeScript",
            root: "/project",
            extensions: [".ts"],
            state: "connected",
          },
        ],
        getClient: () => mockClient as never,
      }),
    );

    await tool.execute(
      { operation: "hover", path: "src/test.ts", line: 1, character: 1 },
      {
        toolCallId: "test",
        onOutput: () => {},
        signal: AbortSignal.timeout(5000),
        log: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({}) as never,
          span: () => ({}) as never,
        },
        cwd: "/project",
      },
    );

    expect(receivedUri).toBe("file:///project/src/test.ts");
  });

  it("position op without line/character returns isError", async () => {
    const tool = createLspTool(
      stubManager({
        status: async () => [
          {
            id: "ts",
            name: "TypeScript",
            root: "/project",
            extensions: [".ts"],
            state: "connected",
          },
        ],
      }),
    );

    const result = await tool.execute(
      { operation: "hover", path: "test.ts" },
      {
        toolCallId: "test",
        onOutput: () => {},
        signal: AbortSignal.timeout(5000),
        log: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({}) as never,
          span: () => ({}) as never,
        },
        cwd: "/project",
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires both");
  });

  it("diagnostics op: a server that times out is skipped with a raise-to-user notice", async () => {
    const mockClient = {
      getState: () => "connected" as const,
      getStateError: () => undefined,
      request: async () => null,
      waitForDiagnostics: async () => ({ formatted: "", slow: false, timedOut: true }),
    };

    const tool = createLspTool(
      stubManager({
        status: async () => [
          {
            id: "steep",
            name: "Steep",
            root: "/project",
            extensions: [".rb"],
            state: "connected",
          },
        ],
        getClient: () => mockClient as never,
      }),
    );

    const result = await tool.execute(
      { operation: "diagnostics", path: "game.rb" },
      {
        toolCallId: "test",
        onOutput: () => {},
        signal: AbortSignal.timeout(5000),
        log: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({}) as never,
          span: () => ({}) as never,
        },
        cwd: "/project",
      },
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("[Steep]");
    expect(result.content).toContain("took too long");
    expect(result.content).toContain(">10s");
    expect(result.content).toContain("raise this to the user");
  });

  it("diagnostics op: responding servers' diagnostics are merged, tagged by source", async () => {
    const mockClient = {
      getState: () => "connected" as const,
      getStateError: () => undefined,
      request: async () => null,
      waitForDiagnostics: async () => ({
        formatted: "ERROR L1:1: boom",
        slow: false,
        timedOut: false,
      }),
    };

    const tool = createLspTool(
      stubManager({
        status: async () => [
          {
            id: "steep",
            name: "Steep",
            root: "/project",
            extensions: [".rb"],
            state: "connected",
          },
        ],
        getClient: () => mockClient as never,
      }),
    );

    const result = await tool.execute(
      { operation: "diagnostics", path: "game.rb" },
      {
        toolCallId: "test",
        onOutput: () => {},
        signal: AbortSignal.timeout(5000),
        log: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({}) as never,
          span: () => ({}) as never,
        },
        cwd: "/project",
      },
    );

    expect(result.content).toContain("[Steep]");
    expect(result.content).toContain("boom");
  });
});

describe("lsp tool — diagnostics served from the background queue", () => {
  function ctx(conversationId: string): ToolExecuteContext {
    return {
      toolCallId: "test",
      onOutput: () => {},
      signal: AbortSignal.timeout(5000),
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => ({}) as never,
        span: () => ({}) as never,
      },
      cwd: "/project",
      conversationId,
    };
  }

  function diag(message: string): Diagnostic {
    return {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      source: "ts",
      message,
    };
  }

  interface Harness {
    readonly queue: DiagnosticsCheckQueue;
    readonly calls: { filePath: string; resolve: (o: CheckOutcome) => void }[];
    readonly delivery: { enqueued: string[]; active: boolean };
  }

  function makeQueue(): Harness {
    const calls: Harness["calls"] = [];
    const deliveryState = { enqueued: [] as string[], active: true };
    const check: CheckRunner = (opts) =>
      new Promise((resolve) => {
        calls.push({ filePath: opts.filePath, resolve });
      });
    const queue = new DiagnosticsCheckQueue({
      check,
      delivery: {
        isActive: () => deliveryState.active,
        enqueue: ({ text }) => {
          deliveryState.enqueued.push(text);
          return { startedTurn: false, messageId: `m${deliveryState.enqueued.length}` };
        },
        cancel: () => true,
        subscribe: () => () => {},
      },
    });
    return { queue, calls, delivery: deliveryState };
  }

  async function tick(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  it("returns the cached full report (all errors + warnings) for a fresh file", async () => {
    const harness = makeQueue();
    let statusCalls = 0;
    const manager = stubManager({
      status: async () => {
        statusCalls += 1;
        return [];
      },
    });
    const tool = createLspTool(manager, { checks: harness.queue });

    harness.queue.queueCheck({
      conversationId: "c1",
      filePath: "/project/src/a.ts",
      text: "v1",
      cwd: "/project",
    });
    harness.calls[0]?.resolve({
      formatted: "[ts]\nERROR (2322) L1:1: not assignable\nWARNING L2:1: unused",
      timedOut: false,
      issues: [diag("not assignable")],
    });
    await tick();

    const result = await tool.execute({ operation: "diagnostics", path: "src/a.ts" }, ctx("c1"));

    expect(result.content).toContain("ERROR (2322) L1:1: not assignable");
    expect(result.content).toContain("WARNING L2:1: unused");
    // Served from the cache — no server scan, no second aggregation.
    expect(statusCalls).toBe(0);
    expect(harness.calls).toHaveLength(1);
  });

  it("waits for an in-flight check instead of starting a second one", async () => {
    const harness = makeQueue();
    const tool = createLspTool(
      stubManager({
        status: async () => [
          {
            id: "ts",
            name: "TypeScript",
            root: "/project",
            extensions: [".ts"],
            state: "connected",
          },
        ],
      }),
      { checks: harness.queue },
    );

    harness.queue.queueCheck({
      conversationId: "c1",
      filePath: "/project/src/a.ts",
      text: "v1",
      cwd: "/project",
    });

    const pending = tool.execute({ operation: "diagnostics", path: "src/a.ts" }, ctx("c1"));
    await tick();
    expect(harness.calls).toHaveLength(1);

    harness.calls[0]?.resolve({
      formatted: "ERROR L1:1: from the in-flight check",
      timedOut: false,
      issues: [diag("inflight")],
    });

    const result = await pending;
    expect(result.content).toContain("from the in-flight check");
    expect(harness.calls).toHaveLength(1);
  });

  it("with no path, lists every file in the conversation that has issues", async () => {
    const harness = makeQueue();
    const tool = createLspTool(stubManager(), { checks: harness.queue });

    harness.queue.queueCheck({
      conversationId: "c1",
      filePath: "/project/src/a.ts",
      text: "a",
      cwd: "/project",
    });
    harness.queue.queueCheck({
      conversationId: "c1",
      filePath: "/project/src/b.ts",
      text: "b",
      cwd: "/project",
    });
    harness.queue.queueCheck({
      conversationId: "c1",
      filePath: "/project/src/clean.ts",
      text: "c",
      cwd: "/project",
    });

    harness.calls[0]?.resolve({ formatted: "ERROR L1:1: a", timedOut: false, issues: [] });
    harness.calls[1]?.resolve({ formatted: "WARNING L3:1: b", timedOut: false, issues: [] });
    harness.calls[2]?.resolve({ formatted: "", timedOut: false, issues: [] });
    await tick();

    const result = await tool.execute({ operation: "diagnostics" }, ctx("c1"));

    expect(result.content).toContain("src/a.ts\nERROR L1:1: a");
    expect(result.content).toContain("src/b.ts\nWARNING L3:1: b");
    expect(result.content).not.toContain("clean.ts");
  });

  it("returns 'No diagnostics found.' when the conversation has no known issues", async () => {
    const harness = makeQueue();
    const tool = createLspTool(stubManager(), { checks: harness.queue });
    const result = await tool.execute({ operation: "diagnostics" }, ctx("c1"));
    expect(result.content).toBe("No diagnostics found.");
  });

  it("still requires a path when no conversation context is available", async () => {
    const tool = createLspTool(stubManager());
    const result = await tool.execute(
      { operation: "diagnostics" },
      {
        toolCallId: "test",
        onOutput: () => {},
        signal: AbortSignal.timeout(5000),
        log: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({}) as never,
          span: () => ({}) as never,
        },
        cwd: "/project",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path");
  });
});
