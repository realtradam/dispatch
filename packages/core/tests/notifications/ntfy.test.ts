import { describe, expect, it, vi } from "vitest";
import { buildNtfyUrl, NTFY_BASE_URL, sendNtfy } from "../../src/notifications/ntfy.js";
import type { NotificationEvent, NtfyConfig } from "../../src/notifications/types.js";

function makeConfig(overrides: Partial<NtfyConfig> = {}): NtfyConfig {
	return {
		enabled: true,
		topic: "my-topic",
		authToken: "",
		events: {
			"turn-completed": true,
			"turn-error": true,
			"permission-required": true,
			"agent-spawned": true,
		},
		notifySubagents: false,
		...overrides,
	};
}

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
	return {
		type: "turn-completed",
		title: "Done",
		message: "all good",
		...overrides,
	};
}

function makeFetch(
	response: Partial<{ ok: boolean; status: number; statusText: string; body: string }> = {},
) {
	const fetchImpl = vi.fn(async () => ({
		ok: response.ok ?? true,
		status: response.status ?? 200,
		statusText: response.statusText ?? "OK",
		text: async () => response.body ?? "",
	}));
	return fetchImpl;
}

describe("buildNtfyUrl", () => {
	it("prefixes the public ntfy.sh host", () => {
		expect(buildNtfyUrl("my-topic")).toBe(`${NTFY_BASE_URL}/my-topic`);
	});

	it("trims surrounding whitespace", () => {
		expect(buildNtfyUrl("  hello  ")).toBe(`${NTFY_BASE_URL}/hello`);
	});

	it("URL-encodes the topic so any string yields a valid URL", () => {
		// Spaces, slashes, unicode — all preserved as encoded bytes; the ntfy
		// server is the final authority on what it accepts.
		expect(buildNtfyUrl("has space")).toBe(`${NTFY_BASE_URL}/has%20space`);
		expect(buildNtfyUrl("a/b")).toBe(`${NTFY_BASE_URL}/a%2Fb`);
		expect(buildNtfyUrl("日本語")).toBe(`${NTFY_BASE_URL}/${encodeURIComponent("日本語")}`);
	});
});

describe("sendNtfy", () => {
	it("POSTs to https://ntfy.sh/<topic> with Title/Priority/Tags/Content-Type headers and body", async () => {
		const fetchImpl = makeFetch();
		const result = await sendNtfy(
			makeConfig(),
			makeEvent({ title: "Hello", message: "World", tags: ["bell"], priority: 4 }),
			fetchImpl,
		);
		expect(result.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe(`${NTFY_BASE_URL}/my-topic`);
		expect(init.method).toBe("POST");
		expect(init.headers.Title).toBe("Hello");
		expect(init.headers.Priority).toBe("4");
		expect(init.headers.Tags).toBe("bell");
		expect(init.headers["Content-Type"]).toMatch(/text\/plain/);
		expect(init.body).toBe("World");
	});

	it("accepts arbitrary topic strings without a client-side pattern check", async () => {
		const fetchImpl = makeFetch();
		// Things the old validator would have rejected — dots, spaces, unicode,
		// a single-word "any topic". All should POST and let ntfy decide.
		await sendNtfy(makeConfig({ topic: "release.notes" }), makeEvent(), fetchImpl);
		await sendNtfy(makeConfig({ topic: "with space" }), makeEvent(), fetchImpl);
		await sendNtfy(makeConfig({ topic: "Any Topic Whatsoever" }), makeEvent(), fetchImpl);
		await sendNtfy(makeConfig({ topic: "日本語" }), makeEvent(), fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(fetchImpl.mock.calls[0][0]).toBe(`${NTFY_BASE_URL}/release.notes`);
		expect(fetchImpl.mock.calls[1][0]).toBe(`${NTFY_BASE_URL}/with%20space`);
		expect(fetchImpl.mock.calls[2][0]).toBe(`${NTFY_BASE_URL}/Any%20Topic%20Whatsoever`);
		expect(fetchImpl.mock.calls[3][0]).toBe(`${NTFY_BASE_URL}/${encodeURIComponent("日本語")}`);
	});

	it("uses per-event-type defaults for priority and tags", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(makeConfig(), makeEvent({ type: "turn-error" }), fetchImpl);
		const init = fetchImpl.mock.calls[0][1];
		expect(init.headers.Priority).toBe("4"); // NTFY_DEFAULT_PRIORITIES["turn-error"]
		expect(init.headers.Tags).toBe("rotating_light");
	});

	it("attaches Authorization header with Bearer prefix when authToken is a bare token", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(makeConfig({ authToken: "tk_secret " }), makeEvent(), fetchImpl);
		const init = fetchImpl.mock.calls[0][1];
		expect(init.headers.Authorization).toBe("Bearer tk_secret");
	});

	it("passes a pre-prefixed Authorization value (Basic, custom schemes) through verbatim", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(makeConfig({ authToken: "Basic dXNlcjpwYXNz" }), makeEvent(), fetchImpl);
		expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Basic dXNlcjpwYXNz");

		const fetchImpl2 = makeFetch();
		await sendNtfy(makeConfig({ authToken: "Bearer already_prefixed" }), makeEvent(), fetchImpl2);
		expect(fetchImpl2.mock.calls[0][1].headers.Authorization).toBe("Bearer already_prefixed");
	});

	it("omits Authorization when authToken is blank", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(makeConfig({ authToken: "   " }), makeEvent(), fetchImpl);
		const init = fetchImpl.mock.calls[0][1];
		expect(init.headers.Authorization).toBeUndefined();
	});

	it("attaches Click header when clickUrl is set", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(makeConfig(), makeEvent({ clickUrl: "https://example.com/tab/abc" }), fetchImpl);
		const init = fetchImpl.mock.calls[0][1];
		expect(init.headers.Click).toBe("https://example.com/tab/abc");
	});

	it("sanitizes Click header (CR/LF injection guard)", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(
			makeConfig(),
			makeEvent({ clickUrl: "https://example.com/\r\nInjected: yes" }),
			fetchImpl,
		);
		const v = fetchImpl.mock.calls[0][1].headers.Click;
		expect(v).not.toContain("\n");
		expect(v).not.toContain("\r");
	});

	it("appends short tab tag when tabId is set", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(
			makeConfig(),
			makeEvent({ tabId: "abcdef0123456789", tags: ["bell"] }),
			fetchImpl,
		);
		const init = fetchImpl.mock.calls[0][1];
		expect(init.headers.Tags).toBe("bell,tab-abcdef01");
	});

	it("strips CR/LF/control chars from header values (injection guard)", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(makeConfig(), makeEvent({ title: "line1\r\nInjected: yes" }), fetchImpl);
		const init = fetchImpl.mock.calls[0][1];
		expect(init.headers.Title).not.toContain("\n");
		expect(init.headers.Title).not.toContain("\r");
		expect(init.headers.Title).toBe("line1 Injected: yes");
	});

	it("returns ok:false when notifications are disabled", async () => {
		const fetchImpl = makeFetch();
		const result = await sendNtfy(makeConfig({ enabled: false }), makeEvent(), fetchImpl);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/disabled/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("returns ok:false when topic is empty / whitespace, without calling fetch", async () => {
		const fetchImpl = makeFetch();
		const empty = await sendNtfy(makeConfig({ topic: "" }), makeEvent(), fetchImpl);
		expect(empty.ok).toBe(false);
		expect(empty.error).toMatch(/required/i);

		const ws = await sendNtfy(makeConfig({ topic: "   " }), makeEvent(), fetchImpl);
		expect(ws.ok).toBe(false);
		expect(ws.error).toMatch(/required/i);

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("returns ok:false with status on non-2xx response", async () => {
		const fetchImpl = makeFetch({ ok: false, status: 403, statusText: "Forbidden", body: "nope" });
		const result = await sendNtfy(makeConfig(), makeEvent(), fetchImpl);
		expect(result.ok).toBe(false);
		expect(result.status).toBe(403);
		expect(result.error).toMatch(/403/);
		expect(result.error).toMatch(/nope/);
	});

	it("returns ok:false with error message on fetch throwing", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		const result = await sendNtfy(makeConfig(), makeEvent(), fetchImpl);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/ECONNREFUSED/);
	});
});
