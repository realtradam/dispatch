import { describe, expect, it, vi } from "vitest";

// Mock @dispatch/core's Agent to avoid real LLM calls
vi.mock("@dispatch/core", async () => {
	const actual = await vi.importActual<typeof import("@dispatch/core")>("@dispatch/core");
	return {
		...actual,
		Agent: class MockAgent {
			status = "idle";
			messages: unknown[] = [];
			async *run(_message: string) {
				yield { type: "status", status: "running" } as const;
				// Simulate some processing time so status stays "running"
				await new Promise<void>((r) => setTimeout(r, 100));
				yield { type: "text-delta", delta: "Hello " } as const;
				yield { type: "text-delta", delta: "world" } as const;
				yield {
					type: "done",
					message: { role: "assistant", content: "Hello world" },
				} as const;
				yield { type: "status", status: "idle" } as const;
			}
		},
	};
});

const { app } = await import("../src/app.js");

describe("GET /health", () => {
	it("returns 200 with ok: true", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
	});
});

describe("GET /status", () => {
	it("returns idle status initially", async () => {
		const res = await app.request("/status");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("idle");
		expect(typeof body.messageCount).toBe("number");
	});
});

describe("POST /chat", () => {
	it("returns 200 with valid message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello world" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});

	it("returns 400 with empty message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 with whitespace-only message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "   " }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 with missing message field", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("returns 409 when agent is already running", async () => {
		// Start a message (non-blocking)
		await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "first message" }),
		});

		// Small delay to let the async generator start and emit "running" status
		await new Promise<void>((r) => setTimeout(r, 20));

		// Immediately send a second — agent should be running
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "second message" }),
		});
		expect(res.status).toBe(409);
	});
});
