import { describe, expect, it } from "vitest";
import { encode } from "./framing.js";
import type { SpawnedProcess, SpawnProcess } from "./transport.js";
import { createStdioTransport } from "./transport.js";

/**
 * In-memory pipe pair: simulates a child process. `emitStdout` pushes framed
 * bytes the server "wrote" to stdout (which we read); `writtenToStdin` captures
 * what we wrote to the child's stdin (our outgoing framed messages).
 */
function makePipe(): {
  process: SpawnedProcess;
  emitStdout: (data: Uint8Array) => void;
  emitEnd: () => void;
  writtenToStdin: () => Uint8Array[];
  killed: () => boolean;
} {
  const dataListeners: Array<(data: Uint8Array) => void> = [];
  const endListeners: Array<() => void> = [];
  const stdinWrites: Uint8Array[] = [];
  let killed = false;

  const process: SpawnedProcess = {
    stdin: {
      write: (bytes: Uint8Array) => {
        stdinWrites.push(bytes);
      },
    },
    stdout: {
      on: (event: string, cb: (data: Uint8Array) => void) => {
        if (event === "data") dataListeners.push(cb);
        else if (event === "end") endListeners.push(cb as unknown as () => void);
      },
    },
    pid: 12345,
    kill: () => {
      killed = true;
    },
  };

  return {
    process,
    emitStdout: (data: Uint8Array) => {
      for (const cb of dataListeners) cb(data);
    },
    emitEnd: () => {
      for (const cb of endListeners) cb();
    },
    writtenToStdin: () => stdinWrites,
    killed: () => killed,
  };
}

describe("createStdioTransport", () => {
  it("creates connection with correct pid", () => {
    const pair = makePipe();
    const spawn: SpawnProcess = () => pair.process;

    const { connection } = createStdioTransport({ spawn, command: ["test-server"] }, "/tmp");

    expect(connection.pid).toBe(12345);
    connection.close();
  });

  it("connection sends newline-delimited messages via stdin (current MCP spec)", () => {
    const pair = makePipe();
    const spawn: SpawnProcess = () => pair.process;

    const { connection } = createStdioTransport({ spawn, command: ["test"] }, "/tmp");

    connection.notify("test/method", { key: "value" });

    const writes = pair.writtenToStdin();
    expect(writes.length).toBe(1);
    const text = new TextDecoder().decode(writes[0]);
    // Outgoing framing is newline-delimited JSON (not Content-Length).
    expect(text).not.toContain("Content-Length:");
    expect(text).toContain('"method":"test/method"');
    expect(text.endsWith("\n")).toBe(true);
    connection.close();
  });

  it("decodes a newline-delimited server response (auto-detect)", async () => {
    const pair = makePipe();
    const spawn: SpawnProcess = () => pair.process;

    const { connection } = createStdioTransport({ spawn, command: ["test"] }, "/tmp");

    const resultPromise = connection.send("tools/list");

    // Server responds with newline-delimited JSON (e.g. chrome-devtools-mcp).
    const response = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] },
    })}\n`;
    pair.emitStdout(new TextEncoder().encode(response));

    const result = await resultPromise;
    expect(result).toEqual({
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    });
    connection.close();
  });

  it("close kills the child process", () => {
    const pair = makePipe();
    const spawn: SpawnProcess = () => pair.process;

    const { connection } = createStdioTransport({ spawn, command: ["test"] }, "/tmp");

    connection.close();
    expect(pair.killed()).toBe(true);
  });

  it("pipes stdout through framing: a notification triggers onNotification", async () => {
    const pair = makePipe();
    const spawn: SpawnProcess = () => pair.process;

    const { connection } = createStdioTransport({ spawn, command: ["test"] }, "/tmp");

    let received: unknown = null;
    connection.onNotification("notifications/tools/list_changed", (params) => {
      received = params;
    });

    // Simulate the server writing a framed notification to stdout.
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: { reason: "tools added" },
    });
    pair.emitStdout(encode(notification));

    // onNotification is invoked synchronously inside the data handler.
    expect(received).toEqual({ reason: "tools added" });
    connection.close();
  });

  it("pipes stdout through framing: a response resolves a request", async () => {
    const pair = makePipe();
    const spawn: SpawnProcess = () => pair.process;

    const { connection } = createStdioTransport({ spawn, command: ["test"] }, "/tmp");

    const resultPromise = connection.send("tools/list");

    // The request was framed and written to stdin; respond via stdout.
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] },
    });
    pair.emitStdout(encode(response));

    const result = await resultPromise;
    expect(result).toEqual({
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    });
    connection.close();
  });

  it("handles a frame split across two stdout chunks", async () => {
    const pair = makePipe();
    const spawn: SpawnProcess = () => pair.process;

    const { connection } = createStdioTransport({ spawn, command: ["test"] }, "/tmp");

    const resultPromise = connection.send("ping");

    const response = encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    const mid = Math.floor(response.length / 2);
    pair.emitStdout(response.slice(0, mid));
    pair.emitStdout(response.slice(mid));

    await expect(resultPromise).resolves.toEqual({ ok: true });
    connection.close();
  });
});
