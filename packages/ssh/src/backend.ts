/**
 * SshExecBackend — implements `ExecBackend` over a pooled SSH connection.
 *
 * `spawn` runs a command on the remote via `client.exec` (shell-quoting the cwd
 * into `cd "<cwd>" && <command>`; ssh2 exec has no cwd option). `readFile`/
 * `writeFile`/`stat`/`readdir`/`exists` use SFTP. Every ssh2/SFTP error is
 * routed through `errors.ts` so it lands as a node:fs-style `.code` error — the
 * bundled tools' existing error branches (e.g. `read_file`'s "File not found"
 * on `ENOENT`) work unchanged (plan §4.3).
 *
 * Built per `acquire`: captures the alias + a lazy `acquire` thunk so merely
 * RESOLVING a backend never opens a connection — only the first actual method
 * call connects (the resolver stays side-effect-free; see exec-backend service).
 */

import { randomUUID } from "node:crypto";
import type {
  DirEntry,
  ExecBackend,
  ExecResult,
  SpawnParams,
  StatResult,
} from "@dispatch/exec-backend";
import type { Client, ClientChannel, Stats } from "ssh2";
import { mapSshError } from "./errors.js";
import type { SshConnection } from "./pool.js";

/** Acquire the pooled connection for an alias (lazy — the backend is built
 *  before any connection exists; acquire runs on first method call). */
export type AcquireConnection = (alias: string) => Promise<SshConnection>;

/**
 * Build a remote `ExecBackend` for `alias`. The connection is acquired lazily
 * inside each method (so resolving a backend in the resolver is free — opening
 * a connection is deferred to the first actual tool call). Only the alias is
 * needed here: the pool re-resolves the real `Computer` (hostName/port/user/key)
 * from `~/.ssh/config` at connect time, so the backend carries no stale params.
 */
export function createSshExecBackend(alias: string, acquire: AcquireConnection): ExecBackend {
  const getConn = (): Promise<SshConnection> => acquire(alias);

  return {
    async spawn(params: SpawnParams): Promise<ExecResult> {
      if (params.signal.aborted) return { exitCode: null, timedOut: false, aborted: true };
      const conn = await getConn();
      return conn.withExec((client) =>
        runExec(client, wrapRemoteCommand(params.cwd, params.command), params),
      );
    },

    async readFile(path: string): Promise<string> {
      const conn = await getConn();
      const sftp = await conn.getSftp();
      return new Promise<string>((resolve, reject) => {
        sftp.readFile(path, "utf8", (err, data) => {
          if (err !== null && err !== undefined) reject(mapSshError(err, `readFile ${path}`));
          else resolve(data.toString("utf8"));
        });
      });
    },

    async readFileBytes(path: string): Promise<Uint8Array> {
      const sftp = await (await getConn()).getSftp();
      return new Promise((resolve, reject) => {
        sftp.readFile(path, (err, data) => {
          if (err) reject(mapSshError(err, `readFileBytes ${path}`));
          else resolve(data);
        });
      });
    },

    async writeFileAtomic(path: string, content: string): Promise<void> {
      const sftp = await (await getConn()).getSftp();
      const call = <T>(run: (cb: (err: Error | undefined | null, value: T) => void) => void) =>
        new Promise<T>((resolve, reject) => {
          try {
            run((err, value) => {
              if (err) reject(mapSshError(err, `writeFileAtomic ${path}`));
              else resolve(value);
            });
          } catch (err) {
            reject(mapSshError(err, `writeFileAtomic ${path}`));
          }
        });
      const target = await call<string>((cb) => sftp.realpath(path, cb));
      const original = await call<Stats>((cb) => sftp.stat(target, cb));
      if (!original.isFile()) throw new Error("Atomic write requires a regular file");
      const temporary = `${target}.dispatch-tmp-${randomUUID()}`;
      const handle = await call<Buffer>((cb) => sftp.open(temporary, "wx", 0o600, cb));
      try {
        try {
          const data = Buffer.from(content, "utf8");
          await call<void>((cb) => sftp.write(handle, data, 0, data.length, 0, cb));
          await call<void>((cb) => sftp.fchmod(handle, original.mode & 0o7777, cb));
        } finally {
          await call<void>((cb) => sftp.close(handle, cb));
        }
        // SFTP v3 rename cannot overwrite an existing file. Require the POSIX
        // extension; never unlink the destination or silently degrade atomicity.
        await call<void>((cb) => sftp.ext_openssh_rename(temporary, target, cb));
      } finally {
        await call<void>((cb) => sftp.unlink(temporary, cb)).catch(() => undefined);
      }
    },

    async writeFile(path: string, content: string): Promise<void> {
      const conn = await getConn();
      const sftp = await conn.getSftp();
      return new Promise<void>((resolve, reject) => {
        sftp.writeFile(path, content, "utf8", (err) => {
          if (err !== null && err !== undefined) reject(mapSshError(err, `writeFile ${path}`));
          else resolve();
        });
      });
    },

    async stat(path: string): Promise<StatResult> {
      const conn = await getConn();
      const sftp = await conn.getSftp();
      return new Promise<StatResult>((resolve, reject) => {
        sftp.stat(path, (err, stats) => {
          if (err !== null && err !== undefined) reject(mapSshError(err, `stat ${path}`));
          else resolve({ isFile: stats.isFile(), isDirectory: stats.isDirectory() });
        });
      });
    },

    async readdir(path: string): Promise<readonly DirEntry[]> {
      const conn = await getConn();
      const sftp = await conn.getSftp();
      return new Promise<readonly DirEntry[]>((resolve, reject) => {
        sftp.readdir(path, (err, list) => {
          if (err !== null && err !== undefined) reject(mapSshError(err, `readdir ${path}`));
          else
            resolve(
              list.map((e): DirEntry => ({ name: e.filename, isDirectory: e.attrs.isDirectory() })),
            );
        });
      });
    },

    async exists(path: string): Promise<boolean> {
      const conn = await getConn();
      const sftp = await conn.getSftp();
      // ssh2's `sftp.exists` invokes the callback with a boolean that is TRUE
      // when the path exists and FALSE when missing (verified empirically).
      // Never throws — a missing path resolves `false`.
      return new Promise<boolean>((resolve) => {
        sftp.exists(path, (exists: boolean) => resolve(exists));
      });
    },
  };
}

// ─── spawn core ─────────────────────────────────────────────────────────────

/** The handshake is emitted INSIDE setsid: $$ is now the actual process-group id.
 * It precedes all user stdout, even for commands that immediately exec or exit.
 * -w preserves status when setsid must fork (sshd can launch a group leader). */
export function wrapRemoteCommand(cwd: string, command: string): string {
  const body = `cd ${shellQuote(cwd)} && ${command}`;
  return `exec setsid -w sh -c ${shellQuote(`printf 'PGID:%s\\n' "$$"; exec sh -c ${shellQuote(body)}`)}`;
}

/** Pure, incremental first-line parser. Invalid/oversized headers pass through. */
export function parsePgidHeader(text: string): {
  pgid: number | null;
  output: string;
  pending: boolean;
} {
  const end = text.indexOf("\n");
  if (end < 0 && text.length < 32) return { pgid: null, output: text, pending: true };
  const line = text.slice(0, end);
  const pgid = end >= 0 && /^PGID:[1-9][0-9]*$/.test(line) ? Number(line.slice(5)) : NaN;
  return Number.isSafeInteger(pgid) && pgid > 1
    ? { pgid, output: text.slice(end + 1), pending: false }
    : { pgid: null, output: text, pending: false };
}

/** Run one command; cancellation waits for the PGID, kills over a separate exec
 * channel, THEN closes the command channel. Cleanup is bounded if the peer dies. */
function runExec(client: Client, command: string, params: SpawnParams): Promise<ExecResult> {
  if (params.signal.aborted)
    return Promise.resolve({ exitCode: null, timedOut: false, aborted: true });
  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let stream: ClientChannel | undefined;
    let killer: ClientChannel | undefined;
    let pgid: number | null = null;
    let header: string | null = "";
    let killing = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const output = (data: string, kind: "stdout" | "stderr"): void => {
      if (!settled && data) params.onOutput(data, kind);
    };
    const settle = (): void => {
      if (settled) return;
      if (header) output(header, "stdout");
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      params.signal.removeEventListener("abort", onAbort);
      client.removeListener("error", onClientError);
      resolve({ exitCode: cancelled ? null : exitCode, timedOut, aborted: cancelled && !timedOut });
    };
    const finishCancellation = (): void => {
      stream?.close();
      killer?.close();
      settle();
    };
    const kill = (): void => {
      if (settled || !cancelled || pgid === null || killing) return;
      killing = true;
      client.exec(`kill -KILL -- -${pgid}`, { pty: false }, (err, channel) => {
        if (err) {
          output("[remote process-group kill failed]\n", "stderr");
          finishCancellation();
          return;
        }
        killer = channel;
        if (settled) {
          channel.close();
          return;
        }
        channel.resume();
        channel.stderr.resume();
        channel.on("exit", (code: number | null) => {
          if (code !== 0) output("[remote process-group kill failed]\n", "stderr");
        });
        channel.on("close", finishCancellation);
      });
    };
    const cancel = (timeout: boolean): void => {
      if (settled || cancelled) return;
      cancelled = true;
      timedOut = timeout;
      cleanupTimer = setTimeout(() => {
        output("[remote cancellation cleanup timed out]\n", "stderr");
        finishCancellation();
      }, 5000);
      kill();
    };
    const onAbort = (): void => cancel(false);
    const onClientError = (): void => {
      exitCode = 1;
      settle();
    };
    const timer = setTimeout(() => cancel(true), params.timeout);
    params.signal.addEventListener("abort", onAbort, { once: true });
    client.on("error", onClientError);
    client.exec(command, { pty: false }, (err, channel) => {
      if (err) {
        exitCode = 1;
        settle();
        return;
      }
      stream = channel;
      if (settled) {
        channel.close();
        return;
      }
      channel.setEncoding("utf8");
      channel.stderr.setEncoding("utf8");
      channel.on("data", (data: string) => {
        if (settled) return;
        if (header !== null) {
          const parsed = parsePgidHeader(header + data);
          if (parsed.pending) {
            header = parsed.output;
            return;
          }
          header = null;
          pgid = parsed.pgid;
          output(parsed.output, "stdout");
          kill();
        } else output(data, "stdout");
      });
      channel.stderr.on("data", (data: string) => output(data, "stderr"));
      channel.on("exit", (code: number | null) => {
        exitCode = code;
      });
      channel.on("close", () => {
        if (!cancelled) settle();
      });
    });
  });
}

// ─── shell quoting ─────────────────────────────────────────────────────────

/**
 * Shell-quote a path for the `cd "<cwd>" && ...` prefix so a cwd containing
 * shell metacharacters cannot break out (plan §7.6). Single-quotes wrap the
 * value and any embedded single-quote is escaped (`'\''`).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
