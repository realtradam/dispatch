/**
 * StdioTransport — spawns a child process and pipes stdin/stdout through
 * Content-Length framing + JSON-RPC.
 */

import { FrameDecoder } from "./framing.js";
import { JsonRpcClient, type WriteFn } from "./rpc.js";

export interface SpawnedProcess {
  readonly stdin: { readonly write: (bytes: Uint8Array) => void };
  readonly stdout:
    | AsyncIterable<Uint8Array>
    | { readonly on: (event: string, cb: (data: Uint8Array) => void) => void };
  readonly stderr?:
    | AsyncIterable<Uint8Array>
    | { readonly on: (event: string, cb: (data: Uint8Array) => void) => void }
    | undefined;
  readonly pid: number | undefined;
  readonly kill: () => void;
}

export type SpawnProcess = (
  command: readonly string[],
  opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> | undefined },
) => SpawnedProcess;

export interface Connection {
  readonly send: (method: string, params?: unknown) => Promise<unknown>;
  readonly notify: (method: string, params?: unknown) => void;
  readonly onNotification: (method: string, handler: (params: unknown) => void) => void;
  readonly close: () => void;
  readonly pid: number | undefined;
}

export interface StdioTransportDeps {
  readonly spawn: SpawnProcess;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export function createStdioTransport(
  deps: StdioTransportDeps,
  cwd: string,
): { connection: Connection; promise: Promise<void> } {
  const spawnOpts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> } = {
    cwd,
  };
  if (deps.env) {
    (spawnOpts as { env?: Readonly<Record<string, string>> }).env = deps.env;
  }

  const proc = deps.spawn(deps.command, spawnOpts);
  const decoder = new FrameDecoder();

  const writeFn: WriteFn = (bytes) => proc.stdin.write(bytes);
  const rpc = new JsonRpcClient(writeFn);

  const stdoutSource = proc.stdout;
  const promise = new Promise<void>((resolve, reject) => {
    if (Symbol.asyncIterator in stdoutSource) {
      (async () => {
        try {
          for await (const chunk of stdoutSource as AsyncIterable<Uint8Array>) {
            const messages = decoder.decode(chunk);
            for (const msg of messages) {
              rpc.handleMessage(msg);
            }
          }
          resolve();
        } catch (err: unknown) {
          reject(err);
        }
      })();
    } else {
      const source = stdoutSource as {
        readonly on: (event: string, cb: (data: Uint8Array) => void) => void;
      };
      source.on("data", (data: Uint8Array) => {
        const messages = decoder.decode(data);
        for (const msg of messages) {
          rpc.handleMessage(msg);
        }
      });
      source.on("end", () => resolve());
      source.on("error", (err: unknown) => reject(err));
    }
  });

  const connection: Connection = {
    send: (method, params) => rpc.request(method, params),
    notify: (method, params) => rpc.notify(method, params),
    onNotification: (method, handler) => rpc.onNotification(method, handler),
    close: () => {
      rpc.close();
      proc.kill();
    },
    pid: proc.pid,
  };

  return { connection, promise };
}
