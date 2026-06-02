import { describe, expect, it, vi } from "vitest";

// `claude.ts` transitively imports `db/index.js`, whose top-level
// `import { Database } from "bun:sqlite"` can't resolve under vitest's Node
// runtime. Stub the db module — `buildWakeProbeBody` never touches it.
vi.mock("../../src/db/index.js", () => ({
	getDatabase: vi.fn(() => {
		throw new Error("db not available in this test");
	}),
}));

const { buildWakeProbeBody } = await import("../../src/credentials/claude.js");

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

describe("buildWakeProbeBody", () => {
	it("targets the requested model with a tiny token budget", () => {
		const body = buildWakeProbeBody("claude-3-5-haiku-20241022");
		expect(body.model).toBe("claude-3-5-haiku-20241022");
		expect(body.max_tokens).toBe(16);
	});

	it("emits a Claude-Code-shaped system[]: billing first, identity second", () => {
		const body = buildWakeProbeBody("claude-3-5-haiku-20241022");
		expect(body.system).toHaveLength(2);

		// system[0] is the billing header line (no cache_control on a probe).
		expect(body.system[0]).toEqual({
			type: "text",
			text: expect.stringMatching(/^x-anthropic-billing-header: /),
		});
		expect(body.system[0]).not.toHaveProperty("cache_control");

		// system[1] is the VERBATIM Claude Code identity string. Anthropic
		// rejects OAuth (Pro/Max) requests whose system[] lacks this.
		expect(body.system[1]).toEqual({ type: "text", text: IDENTITY });
	});

	it("carries a single short user message", () => {
		const body = buildWakeProbeBody("claude-3-5-haiku-20241022");
		expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
	});

	it("is deterministic for a given model (pure)", () => {
		const a = buildWakeProbeBody("claude-3-5-haiku-20241022");
		const b = buildWakeProbeBody("claude-3-5-haiku-20241022");
		expect(a).toEqual(b);
	});
});
