import { PassThrough } from "node:stream";
import type { Client, ClientChannel } from "ssh2";
import { describe, expect, it } from "vitest";
import { createSshExecBackend, parsePgidHeader, shellQuote, wrapRemoteCommand } from "./backend.js";
import type { SshConnection } from "./pool.js";

describe("remote process-group wrapper and header parser", () => {
  it("aborts before the PGID arrives, then kills on a separate channel before closing", async () => {
    const command = Object.assign(new PassThrough(), {
      stderr: new PassThrough(),
      close: () => {
        closed = true;
      },
    });
    const killer = Object.assign(new PassThrough(), {
      stderr: new PassThrough(),
      close: () => undefined,
    });
    let closed = false;
    let calls = 0;
    const client = Object.assign(new PassThrough(), {
      exec: (text: string, _opts: unknown, cb: (err: null, channel: ClientChannel) => void) => {
        calls++;
        if (calls === 1) cb(null, command as unknown as ClientChannel);
        else {
          expect(text).toBe("kill -KILL -- -12345");
          expect(closed).toBe(false);
          cb(null, killer as unknown as ClientChannel);
        }
      },
    }) as unknown as Client;
    const conn: SshConnection = {
      getClient: async () => client,
      withExec: (run) => run(client),
      inFlightExecs: 0,
      getSftp: async () => {
        throw new Error("unused");
      },
      close: async () => undefined,
      state: "connected",
      error: undefined,
    };
    const controller = new AbortController();
    let output = "";
    const result = createSshExecBackend("test", async () => conn).spawn({
      command: "sleep 600",
      cwd: "/",
      signal: controller.signal,
      timeout: 10_000,
      onOutput: (data) => {
        output += data;
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    expect(calls).toBe(1);
    command.write("PGID:12");
    command.write("345\nhello");
    expect(calls).toBe(2);
    expect(closed).toBe(false);
    killer.emit("close");
    expect(await result).toEqual({ exitCode: null, timedOut: false, aborted: true });
    expect(output).toBe("hello");
    expect(closed).toBe(true);
    expect(client.listenerCount("error")).toBe(0);
  });
  it("does not acquire a connection for a pre-aborted command", async () => {
    const backend = createSshExecBackend("test", async () => {
      throw new Error("must not acquire");
    });
    expect(
      await backend.spawn({
        command: "sleep 600",
        cwd: "/",
        signal: AbortSignal.abort(),
        timeout: 100,
        onOutput: () => undefined,
      }),
    ).toEqual({ exitCode: null, timedOut: false, aborted: true });
  });
  it("builds a quoted wrapper without evaluating shell metacharacters", () => {
    expect(wrapRemoteCommand("/tmp/a'b", "echo '$HOME'; exit 7")).toBe(
      `exec setsid -w sh -c ${shellQuote(`printf 'PGID:%s\\n' "$$"; exec sh -c ${shellQuote(`cd ${shellQuote("/tmp/a'b")} && echo '$HOME'; exit 7`)}`)}`,
    );
  });
  it("buffers each possible split of the first line, strips only that line", () => {
    const header = "PGID:12345\n";
    for (let split = 0; split < header.length; split++) {
      const first = parsePgidHeader(header.slice(0, split));
      expect(first.pending).toBe(true);
      expect(parsePgidHeader(`${first.output}${header.slice(split)}hello\nPGID:99\n`)).toEqual({
        pgid: 12345,
        output: "hello\nPGID:99\n",
        pending: false,
      });
    }
  });
  it.each([
    "PGID:0\n",
    "PGID:1\n",
    "PGID:-2\n",
    "PGID:12;evil\n",
    "PGID:9007199254740992\n",
    "plain\n",
    "x".repeat(32),
  ])("passes through an invalid header: %j", (text) => {
    expect(parsePgidHeader(text)).toEqual({ pgid: null, output: text, pending: false });
  });
});
