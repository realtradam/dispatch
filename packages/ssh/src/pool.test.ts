/**
 * Unit tests for the pooled ssh2.Client error lifecycle in pool.ts.
 *
 * The ssh2.Client (the outermost network edge) is faked via EventEmitter —
 * permitted by the constitution (mocking the outermost edge is fine; only
 * `@dispatch/*` may not be mocked). These tests prove the permanent
 * `'error'` listener survives `cleanup()` (which only removes the connect-time
 * onReady/onError) and that a post-connect ssh2 error is captured, logged, and
 * non-throwing, with the connection reconnecting on the next acquire.
 */

import { EventEmitter } from "node:events";
import type { Logger } from "@dispatch/kernel";
import type { Computer } from "@dispatch/wire";
import type { Client } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { createSshConnectionPool } from "./pool.js";

const computer: Computer = {
  alias: "testremote",
  hostName: "localhost",
  port: 22,
  user: "testuser",
  identityFile: null,
  knownHost: false,
};

interface CapturedError {
  msg: string;
  err: unknown;
  alias?: string;
  message?: string;
  level?: string;
  from?: string;
  to?: string;
}

function capturingLogger(calls: CapturedError[]): Logger {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg, attrs) => {
      calls.push({
        msg,
        err: attrs?.err,
        alias: attrs?.alias as string | undefined,
        message: attrs?.message as string | undefined,
        level: attrs?.level as string | undefined,
        from: attrs?.from as string | undefined,
        to: attrs?.to as string | undefined,
      });
    },
    child: () => log,
    span: (name) => ({
      id: name,
      log,
      setAttributes: () => undefined,
      addLink: () => undefined,
      child: (n) => ({ id: n, log }) as never,
      end: () => undefined,
    }),
  };
  return log;
}

/** A fake ssh2.Client: EventEmitter + connect/emd/sftp. `connect` emits 'ready'. */
function fakeClient(): { client: Client; ee: EventEmitter } {
  const ee = new EventEmitter();
  const api = {
    connect: () => {
      process.nextTick(() => ee.emit("ready"));
    },
    end: () => undefined,
    sftp: (cb: (err: Error | null, sftp: unknown) => void) => cb(null, {}),
  };
  return { client: Object.assign(ee, api) as unknown as Client, ee };
}

function makeDeps(client: Client, logger: Logger) {
  return {
    logger,
    homeDir: "/tmp",
    knownHostsPath: "/tmp/known_hosts",
    readFileText: async (p: string): Promise<string> => {
      if (p === "/tmp/known_hosts") return "";
      return "ssh-ed25519 not-encrypted-key";
    },
    appendKnownHosts: async () => undefined,
    pathExists: async () => true,
    newClient: () => client,
    resolveComputer: async () => computer,
  };
}

describe("SshConnectionPool — permanent pooled-client error listener", () => {
  let pool: ReturnType<typeof createSshConnectionPool>;

  afterEach(async () => {
    await pool?.closeAll();
  });

  it("captures a post-connect 'error' without throwing, sets state=error, and logs", async () => {
    const errorCalls: CapturedError[] = [];
    const { client, ee } = fakeClient();
    pool = createSshConnectionPool(makeDeps(client, capturingLogger(errorCalls)));

    const conn = await pool.acquire("testremote");
    expect(conn.state).toBe("connected");

    const sshErr = Object.assign(new Error("Timed out while waiting for handshake"), {
      level: "socket",
    });

    expect(() => ee.emit("error", sshErr)).not.toThrow();

    expect(conn.state).toBe("error");
    expect(conn.error).toBe("Timed out while waiting for handshake");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]?.msg).toBe("ssh: pooled client error");
    expect(errorCalls[0]?.alias).toBe("testremote");
    expect(errorCalls[0]?.message).toBe("Timed out while waiting for handshake");
    expect(errorCalls[0]?.level).toBe("socket");
    expect(errorCalls[0]?.from).toBe("connected");
    expect(errorCalls[0]?.to).toBe("error");
  });

  it("does NOT remove the permanent listener on successful connect (survives cleanup)", async () => {
    const errorCalls: CapturedError[] = [];
    const { client, ee } = fakeClient();
    pool = createSshConnectionPool(makeDeps(client, capturingLogger(errorCalls)));

    const conn = await pool.acquire("testremote");
    expect(conn.state).toBe("connected");

    ee.emit("error", new Error("post-connect drop"));
    expect(conn.state).toBe("error");
    expect(errorCalls).toHaveLength(1);
  });

  it("reconnects on the next acquire after a post-connect error", async () => {
    const { client, ee } = fakeClient();
    pool = createSshConnectionPool(makeDeps(client, capturingLogger([])));

    const conn = await pool.acquire("testremote");
    expect(conn.state).toBe("connected");

    ee.emit("error", new Error("post-connect drop"));
    expect(conn.state).toBe("error");

    const conn2 = await pool.acquire("testremote");
    expect(conn2.state).toBe("connected");
    expect(conn2.error).toBeUndefined();
  });

  it("logs the connect-time error too (permanent listener fires during handshake)", async () => {
    const errorCalls: CapturedError[] = [];
    const ee = new EventEmitter();
    const api = {
      connect: () => {
        process.nextTick(() => ee.emit("error", new Error("connect refused")));
      },
      end: () => undefined,
      sftp: (cb: (err: Error | null, sftp: unknown) => void) => cb(null, {}),
    };
    const client = Object.assign(ee, api) as unknown as Client;
    pool = createSshConnectionPool(makeDeps(client, capturingLogger(errorCalls)));

    const conn = await pool.acquire("testremote");
    expect(conn.state).toBe("error");
    expect(conn.error).toBe("connect refused");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]?.msg).toBe("ssh: pooled client error");
    expect(errorCalls[0]?.message).toBe("connect refused");
  });
});
