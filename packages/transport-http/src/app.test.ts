import type { AgentEvent } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { SessionOrchestrator } from "./seam.js";

function createFakeOrchestrator(events: AgentEvent[]): SessionOrchestrator {
	return {
		async handleMessage(input) {
			for (const event of events) {
				input.onEvent(event);
			}
		},
	};
}

function createThrowingOrchestrator(error: Error): SessionOrchestrator {
	return {
		async handleMessage() {
			throw error;
		},
	};
}

describe("GET /health", () => {
	it("returns ok", async () => {
		const app = createApp({ orchestrator: createFakeOrchestrator([]) });
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
	});
});

describe("POST /chat", () => {
	it("returns 400 for invalid JSON", async () => {
		const app = createApp({ orchestrator: createFakeOrchestrator([]) });
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 for missing message", async () => {
		const app = createApp({ orchestrator: createFakeOrchestrator([]) });
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: "c1" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("message");
	});

	it("returns 400 for empty message", async () => {
		const app = createApp({ orchestrator: createFakeOrchestrator([]) });
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("streams events as NDJSON", async () => {
		const events: AgentEvent[] = [
			{ type: "turn-start", conversationId: "tab1", turnId: "turn1" },
			{ type: "text-delta", conversationId: "tab1", turnId: "turn1", delta: "Hello" },
			{ type: "text-delta", conversationId: "tab1", turnId: "turn1", delta: " world" },
			{ type: "done", conversationId: "tab1", turnId: "turn1", reason: "stop" },
		];
		const app = createApp({ orchestrator: createFakeOrchestrator(events) });

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi", conversationId: "conv1" }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
		expect(res.headers.get("X-Conversation-Id")).toBe("conv1");

		const text = await res.text();
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(4);

		const parsed = lines.map((line) => JSON.parse(line) as AgentEvent);
		expect(parsed[0]?.type).toBe("turn-start");
		expect(parsed[1]?.type).toBe("text-delta");
		expect((parsed[1] as { delta: string }).delta).toBe("Hello");
		expect(parsed[2]?.type).toBe("text-delta");
		expect(parsed[3]?.type).toBe("done");
	});

	it("generates conversationId when not provided", async () => {
		const app = createApp({
			orchestrator: createFakeOrchestrator([
				{ type: "done", conversationId: "tab1", turnId: "turn1", reason: "stop" },
			]),
			generateId: () => "generated-uuid",
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("X-Conversation-Id")).toBe("generated-uuid");
	});

	it("emits error event when orchestrator throws", async () => {
		const app = createApp({
			orchestrator: createThrowingOrchestrator(new Error("provider unavailable")),
		});

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi", conversationId: "conv1" }),
		});

		expect(res.status).toBe(200);
		const text = await res.text();
		const lines = text.trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(1);

		const lastLine = lines[lines.length - 1];
		if (!lastLine) throw new Error("expected at least one line");
		const lastEvent = JSON.parse(lastLine) as AgentEvent;
		expect(lastEvent.type).toBe("error");
		if (lastEvent.type === "error") {
			expect(lastEvent.message).toContain("provider unavailable");
		}
	});

	it("handles empty event list", async () => {
		const app = createApp({ orchestrator: createFakeOrchestrator([]) });

		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});

		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toBe("");
	});
});
