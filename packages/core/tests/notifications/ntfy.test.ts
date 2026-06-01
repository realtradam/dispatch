import { describe, expect, it, vi } from "vitest";
import { sendNtfy, validateTopicUrl } from "../../src/notifications/ntfy.js";
import type { NotificationEvent, NtfyConfig } from "../../src/notifications/types.js";

function makeConfig(overrides: Partial<NtfyConfig> = {}): NtfyConfig {
	return {
		enabled: true,
		topicUrl: "https://ntfy.sh/my-topic",
		authToken: "",
		events: {
			"turn-completed": true,
			"turn-error": true,
			"permission-required": true,
			"agent-spawned": true,
		},
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

describe("validateTopicUrl", () => {
	it("accepts ntfy.sh-style URLs", () => {
		expect(validateTopicUrl("https://ntfy.sh/my-topic")).toBeNull();
		expect(validateTopicUrl("http://ntfy.example.com/team-alerts")).toBeNull();
	});

	it("rejects empty / whitespace", () => {
		expect(validateTopicUrl("")).toMatch(/required/);
		expect(validateTopicUrl("   ")).toMatch(/required/);
	});

	it("rejects malformed URLs", () => {
		expect(validateTopicUrl("not a url")).toMatch(/valid URL/);
	});

	it("rejects non-http(s) schemes", () => {
		expect(validateTopicUrl("ftp://ntfy.sh/topic")).toMatch(/http/);
	});

	it("rejects URLs missing a topic path", () => {
		expect(validateTopicUrl("https://ntfy.sh")).toMatch(/topic/);
		expect(validateTopicUrl("https://ntfy.sh/")).toMatch(/topic/);
	});
});

describe("sendNtfy", () => {
	it("POSTs to the topic URL with Title/Priority/Tags/Content-Type headers and body", async () => {
		const fetchImpl = makeFetch();
		const result = await sendNtfy(
			makeConfig(),
			makeEvent({ title: "Hello", message: "World", tags: ["bell"], priority: 4 }),
			fetchImpl,
		);
		expect(result.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://ntfy.sh/my-topic");
		expect(init.method).toBe("POST");
		expect(init.headers.Title).toBe("Hello");
		expect(init.headers.Priority).toBe("4");
		expect(init.headers.Tags).toBe("bell");
		expect(init.headers["Content-Type"]).toMatch(/text\/plain/);
		expect(init.body).toBe("World");
	});

	it("uses per-event-type defaults for priority and tags", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(makeConfig(), makeEvent({ type: "turn-error" }), fetchImpl);
		const init = fetchImpl.mock.calls[0][1];
		expect(init.headers.Priority).toBe("4"); // NTFY_DEFAULT_PRIORITIES["turn-error"]
		expect(init.headers.Tags).toBe("rotating_light");
	});

	it("attaches Authorization header when authToken is set", async () => {
		const fetchImpl = makeFetch();
		await sendNtfy(makeConfig({ authToken: "tk_secret " }), makeEvent(), fetchImpl);
		const init = fetchImpl.mock.calls[0][1];
		expect(init.headers.Authorization).toBe("Bearer tk_secret");
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

	it("returns ok:false on invalid topic URL without calling fetch", async () => {
		const fetchImpl = makeFetch();
		const result = await sendNtfy(makeConfig({ topicUrl: "not a url" }), makeEvent(), fetchImpl);
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
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
