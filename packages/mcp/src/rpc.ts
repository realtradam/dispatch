/**
 * JSON-RPC 2.0 client over an injected write function.
 *
 * Provides request (correlated by id), notify, and onNotification.
 * The caller feeds decoded JSON messages via `handleMessage`.
 */

import { encode } from "./framing.js";

export type WriteFn = (bytes: Uint8Array) => void;

export interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: unknown) => void;
}

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

export class JsonRpcClient {
	private nextId = 1;
	private pending = new Map<number | string, PendingRequest>();
	private notificationHandlers = new Map<string, NotificationHandler>();
	private write: WriteFn;
	private closed = false;

	constructor(write: WriteFn) {
		this.write = write;
	}

	request(method: string, params?: unknown): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new Error("Connection closed"));
		}
		const id = this.nextId++;
		const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.sendMessage(msg);
		});
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		const msg: JsonRpcMessage = { jsonrpc: "2.0", method, params };
		this.sendMessage(msg);
	}

	onNotification(method: string, handler: NotificationHandler): void {
		this.notificationHandlers.set(method, handler);
	}

	handleMessage(json: string): void {
		const msg = JSON.parse(json) as JsonRpcMessage;
		const { id, method } = msg;

		if (method !== undefined && id === undefined) {
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

	private handleIncomingNotification(method: string, params: unknown): void {
		const handler = this.notificationHandlers.get(method);
		if (handler) {
			handler(params);
		}
	}

	close(): void {
		this.closed = true;
		for (const entry of this.pending.values()) {
			entry.reject(new Error("Connection closed"));
		}
		this.pending.clear();
	}
}
