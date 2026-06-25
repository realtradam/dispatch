import { describe, expect, it } from "vitest";
import { JsonRpcConnection } from "./rpc.js";

function makeConnection(): { conn: JsonRpcConnection; messages: string[] } {
	const messages: string[] = [];
	const conn = new JsonRpcConnection((bytes) => {
		const decoded = new TextDecoder().decode(bytes);
		// Extract JSON from the LSP-framed message
		const headerEnd = decoded.indexOf("\r\n\r\n");
		if (headerEnd !== -1) {
			messages.push(decoded.slice(headerEnd + 4));
		}
	});
	return { conn, messages };
}

function frameResponse(id: number, result: unknown): string {
	return JSON.stringify({ jsonrpc: "2.0", id, result });
}

describe("rpc", () => {
	it("sendRequest resolves by matching id", async () => {
		const { conn, messages } = makeConnection();

		const promise = conn.sendRequest("test/method", { key: "value" });
		expect(messages).toHaveLength(1);

		const rawSent = messages[0];
		if (rawSent === undefined) throw new Error("expected a sent message");
		const sent = JSON.parse(rawSent);
		expect(sent.method).toBe("test/method");
		expect(sent.params).toEqual({ key: "value" });
		expect(sent.id).toBe(1);

		conn.handleMessage(frameResponse(1, { ok: true }));
		const result = await promise;
		expect(result).toEqual({ ok: true });
	});

	it("onNotification dispatches by method", () => {
		const { conn } = makeConnection();
		let received: unknown = null;
		conn.onNotification("test/notify", (params) => {
			received = params;
		});

		conn.handleMessage(
			JSON.stringify({ jsonrpc: "2.0", method: "test/notify", params: { data: 42 } }),
		);
		expect(received).toEqual({ data: 42 });
	});

	it("onRequest replies to a server-to-client request", async () => {
		const { conn, messages } = makeConnection();

		conn.onRequest("workspace/configuration", (params) => {
			const { items } = params as { readonly items: readonly { readonly section?: string }[] };
			return items.map(() => ({ setting: true }));
		});

		await conn.handleMessage(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 100,
				method: "workspace/configuration",
				params: { items: [{ section: "test" }] },
			}),
		);

		// The response should be sent back
		expect(messages).toHaveLength(1);
		const rawResponse = messages[0];
		if (rawResponse === undefined) throw new Error("expected a response message");
		const response = JSON.parse(rawResponse);
		expect(response.id).toBe(100);
		expect(response.result).toEqual([{ setting: true }]);
	});
});

it("handleMessage does not throw on malformed JSON", async () => {
	const { conn } = makeConnection();
	// A corrupted/truncated LSP message — must not throw or reject.
	await expect(conn.handleMessage("{ broken json")).resolves.toBeUndefined();
	await expect(conn.handleMessage("")).resolves.toBeUndefined();
	await expect(conn.handleMessage("not json at all")).resolves.toBeUndefined();
});

describe("sendRequest timeout", () => {
	it("rejects with a timeout error when no response arrives within timeoutMs", async () => {
		const { conn } = makeConnection();
		const promise = conn.sendRequest("textDocument/hover", {}, 50);
		await expect(promise).rejects.toThrow(/LSP request timed out after 50ms: textDocument\/hover/);
	});

	it("clears the timer on a normal response (no unhandled rejection)", async () => {
		const { conn } = makeConnection();
		const promise = conn.sendRequest("textDocument/hover", {}, 5000);
		conn.handleMessage(frameResponse(1, { ok: true }));
		await expect(promise).resolves.toEqual({ ok: true });
		// Give the (now-cleared) timer window ample time to prove it never fires.
		await new Promise((r) => setTimeout(r, 80));
	});

	it("does not time out when no timeoutMs is given (initialize handshake path)", async () => {
		const { conn } = makeConnection();
		const promise = conn.sendRequest("initialize", {});
		// A late response well past any plausible default still resolves.
		await new Promise((r) => setTimeout(r, 60));
		conn.handleMessage(frameResponse(1, { capabilities: {} }));
		await expect(promise).resolves.toEqual({ capabilities: {} });
	});
});
