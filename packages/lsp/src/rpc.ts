/**
 * JSON-RPC connection over an injected write function.
 *
 * Provides sendRequest (correlated by id), sendNotification, onRequest,
 * and onNotification. The caller feeds decoded JSON messages via `handleMessage`.
 */

import { encode } from "./framing.js";

export type WriteFn = (bytes: Uint8Array) => void;

export interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

export interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number | string | undefined;
  readonly method?: string | undefined;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?:
    | { readonly code: number; readonly message: string; readonly data?: unknown }
    | undefined;
}

export class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private write: WriteFn;

  constructor(write: WriteFn) {
    this.write = write;
  }

  /**
   * Send a request and await the correlated response. If `timeoutMs` is given,
   * the promise rejects with a timeout error after that long — so a dead/slow
   * server can't hang the caller forever (hover/definition/references).
   * No `timeoutMs` = wait indefinitely (used by the initialize handshake, which
   * has its own 45s race).
   */
  sendRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Wrap resolve/reject so the timer is cleared on a normal response
      // (or on dispose) — no dangling timer after completion.
      const finish = (fn: () => void): void => {
        if (timer) clearTimeout(timer);
        fn();
      };
      const entry: PendingRequest = {
        resolve: (value: unknown) => finish(() => resolve(value)),
        reject: (reason: unknown) => finish(() => reject(reason)),
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`LSP request timed out after ${timeoutMs}ms: ${method}`));
          }
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.sendMessage(msg);
    });
  }

  sendNotification(method: string, params?: unknown): void {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", method, params };
    this.sendMessage(msg);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  async handleMessage(json: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(json) as JsonRpcMessage;
    } catch {
      // A malformed LSP message must never crash the server. The most
      // common cause is a multi-byte UTF-8 character split across stdout
      // chunks (see FrameDecoder). Log and skip — the language server
      // will re-send diagnostics on the next file change.
      return;
    }
    const { id, method } = msg;

    if (id !== undefined && method !== undefined) {
      await this.handleIncomingRequest(id, method, msg.params);
    } else if (method !== undefined) {
      this.handleIncomingNotification(method, msg.params);
    } else if (id !== undefined) {
      this.handleResponse(id, msg);
    }
  }

  private sendMessage(msg: JsonRpcMessage): void {
    this.write(encode(JSON.stringify(msg)));
  }

  private handleResponse(id: number | string, msg: JsonRpcMessage): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (msg.error) {
      entry.reject(new Error(msg.error.message));
    } else {
      entry.resolve(msg.result);
    }
  }

  private async handleIncomingRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.sendMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.sendMessage({ jsonrpc: "2.0", id, result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message },
      });
    }
  }

  private handleIncomingNotification(method: string, params: unknown): void {
    const handler = this.notificationHandlers.get(method);
    if (handler) {
      handler(params);
    }
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      entry.reject(new Error("Connection closed"));
    }
    this.pending.clear();
  }
}
