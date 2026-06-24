import { describe, expect, it } from "vitest";
import { JsonRpcClient } from "./rpc.js";

function makeClient(): {
	client: JsonRpcClient;
	written: Uint8Array[];
	feedMessage: (msg: unknown) => void;
} {
	const written: Uint8Array[] = [];
	const client = new JsonRpcClient((bytes) => {
		written.push(bytes);
	});
	return {
		client,
		written,
		feedMessage: (msg: unknown) => {
			client.handleMessage(JSON.stringify(msg));
		},
	};
}

describe("JsonRpcClient", () => {
	it("request returns result", async () => {
		const { client, feedMessage } = makeClient();

		const resultPromise = client.request("initialize", { protocolVersion: "2025-11-25" });

		feedMessage({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } });

		const result = await resultPromise;
		expect(result).toEqual({ protocolVersion: "2025-11-25" });
	});

	it("request rejects on error response", async () => {
		const { client, feedMessage } = makeClient();

		const resultPromise = client.request("bad-method");

		feedMessage({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32601, message: "Method not found" },
		});

		await expect(resultPromise).rejects.toThrow("Method not found");
	});

	it("notify sends without expecting response", () => {
		const { client, written } = makeClient();

		client.notify("notifications/initialized", {});

		expect(written.length).toBe(1);
		const sent = new TextDecoder().decode(written[0]);
		expect(sent).toContain('"method":"notifications/initialized"');
		expect(sent).not.toContain('"id"');
	});

	it("onNotification fires for matching method", () => {
		const { client, feedMessage } = makeClient();

		let received: unknown = "unset";
		client.onNotification("notifications/tools/list_changed", (params) => {
			received = params;
		});

		feedMessage({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { a: 1 } });

		expect(received).toEqual({ a: 1 });
	});

	it("pending request rejected on close", async () => {
		const { client } = makeClient();

		const resultPromise = client.request("slow-method");

		client.close();

		await expect(resultPromise).rejects.toThrow("Connection closed");
	});

	it("incremental request ids", () => {
		const { client, written } = makeClient();

		client.request("a");
		client.request("b");
		client.request("c");

		expect(written.length).toBe(3);
		// Extract JSON body from Content-Length framed messages
		const parse = (bytes: Uint8Array): { id: number } => {
			const text = new TextDecoder().decode(bytes);
			const bodyStart = text.indexOf("\r\n\r\n") + 4;
			return JSON.parse(text.slice(bodyStart)) as { id: number };
		};
		const msg1 = parse(written[0]);
		const msg2 = parse(written[1]);
		const msg3 = parse(written[2]);
		expect(msg1.id).toBe(1);
		expect(msg2.id).toBe(2);
		expect(msg3.id).toBe(3);
	});

	it("notify after close is silently dropped", () => {
		const { client, written } = makeClient();
		client.close();
		const count = written.length;
		client.notify("test");
		expect(written.length).toBe(count);
	});

	it("request after close rejects immediately", async () => {
		const { client } = makeClient();
		client.close();
		await expect(client.request("test")).rejects.toThrow("Connection closed");
	});
});
