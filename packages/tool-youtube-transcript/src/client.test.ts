import { describe, expect, it } from "vitest";
import { createTranscriptClient, type FetchLike } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

interface CapturedCall {
	url: string;
	method?: string | undefined;
}

/** Builds a fake fetch that returns scripted responses in order, capturing each call. */
function makeFetch(responses: Response[]): { fetchFn: FetchLike; calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	let i = 0;
	const fetchFn: FetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, method: init?.method });
		return responses[i++] ?? jsonResponse({});
	}) as unknown as FetchLike;
	return { fetchFn, calls };
}

const BASE = "http://test-transcriber.local";
const signal = (): AbortSignal => new AbortController().signal;

describe("createTranscriptClient.getTranscript", () => {
	it("sends GET /api/transcript?url=...", async () => {
		const { fetchFn, calls } = makeFetch([
			jsonResponse({
				status: "completed",
				video_id: "v1",
				full_text: "",
				segments: [],
			}),
		]);
		const client = createTranscriptClient({ baseUrl: BASE, fetchFn });
		await client.getTranscript("https://youtu.be/v1", signal());

		const call = calls[0];
		if (!call) throw new Error("no call captured");
		expect(call.url).toBe(
			`${BASE}/api/transcript?url=${encodeURIComponent("https://youtu.be/v1")}`,
		);
		expect(call.method).toBe("GET");
	});

	it("returns completed response", async () => {
		const body = {
			status: "completed" as const,
			video_id: "v1",
			full_text: "hi",
			segments: [{ text: "hi", start: 0, duration: 1 }],
		};
		const { fetchFn } = makeFetch([jsonResponse(body)]);
		const client = createTranscriptClient({ baseUrl: BASE, fetchFn });
		const result = await client.getTranscript("https://youtu.be/v1", signal());
		expect(result).toEqual(body);
	});

	it("returns queued response", async () => {
		const body = {
			status: "queued" as const,
			video_id: "v1",
			position: 2,
			estimated_seconds: 60,
		};
		const { fetchFn } = makeFetch([jsonResponse(body)]);
		const client = createTranscriptClient({ baseUrl: BASE, fetchFn });
		const result = await client.getTranscript("https://youtu.be/v1", signal());
		expect(result).toEqual(body);
	});

	it("returns failed response", async () => {
		const body = {
			status: "failed" as const,
			video_id: "v1",
			error: "boom",
			error_type: "DownloadError",
		};
		const { fetchFn } = makeFetch([jsonResponse(body)]);
		const client = createTranscriptClient({ baseUrl: BASE, fetchFn });
		const result = await client.getTranscript("https://youtu.be/v1", signal());
		expect(result).toEqual(body);
	});

	it("throws on HTTP error", async () => {
		const { fetchFn } = makeFetch([
			new Response("not found", { status: 404, statusText: "Not Found" }),
		]);
		const client = createTranscriptClient({ baseUrl: BASE, fetchFn });
		await expect(client.getTranscript("https://youtu.be/v1", signal())).rejects.toThrow("HTTP 404");
	});

	it("throws on timeout", async () => {
		const fetchFn: FetchLike = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const sig = init?.signal;
				if (!sig) return;
				sig.addEventListener("abort", () => {
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				});
			})) as unknown as FetchLike;
		const client = createTranscriptClient({ baseUrl: BASE, fetchFn, timeoutMs: 10 });
		await expect(client.getTranscript("https://youtu.be/v1", signal())).rejects.toThrow(
			"timed out",
		);
	});

	it("respects abort signal", async () => {
		const controller = new AbortController();
		const fetchFn: FetchLike = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const sig = init?.signal;
				if (!sig) return;
				sig.addEventListener("abort", () => {
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				});
			})) as unknown as FetchLike;
		const client = createTranscriptClient({ baseUrl: BASE, fetchFn, timeoutMs: 30_000 });
		const promise = client.getTranscript("https://youtu.be/v1", controller.signal);
		controller.abort();
		await expect(promise).rejects.toThrow("aborted");
	});
});
