import { describe, expect, it } from "vitest";
import { transformClaudeOAuthBody } from "../../src/llm/anthropic-oauth-transform.js";

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING =
	"x-anthropic-billing-header: cc_version=2.1.112.abc; cc_entrypoint=sdk-cli; cch=12345;";

interface WireBody {
	system?: Array<{ type: string; text: string; cache_control?: unknown }>;
	messages?: Array<{ role: string; content: unknown }>;
}

/**
 * Build the body shape Dispatch produces: ONE system block holding
 * `<billing>\n<identity>\n\n<systemPrompt>`, marked with cache_control by
 * `applyAnthropicCaching`.
 */
function dispatchBody(systemPrompt: string, firstUser = "hello"): string {
	return JSON.stringify({
		model: "claude-opus-4-8",
		system: [
			{
				type: "text",
				text: `${BILLING}\n${IDENTITY}\n\n${systemPrompt}`,
				cache_control: { type: "ephemeral" },
			},
		],
		messages: [{ role: "user", content: firstUser }],
	});
}

function parse(out: BodyInit | null | undefined): WireBody {
	return JSON.parse(out as string) as WireBody;
}

describe("transformClaudeOAuthBody", () => {
	it("isolates the billing header as system[0] WITHOUT cache_control", () => {
		const result = parse(transformClaudeOAuthBody(dispatchBody("You are Dispatch. Use tools.")));
		const sys = result.system ?? [];
		expect(sys[0]?.text).toBe(BILLING);
		expect(sys[0]?.cache_control).toBeUndefined();
	});

	it("keeps the identity as a separate system block and carries the cache_control there", () => {
		const result = parse(transformClaudeOAuthBody(dispatchBody("You are Dispatch. Use tools.")));
		const sys = result.system ?? [];
		expect(sys[1]?.text).toBe(IDENTITY);
		expect(sys[1]?.cache_control).toEqual({ type: "ephemeral" });
		// Only billing + identity remain in system[] — the third-party prompt was moved out.
		expect(sys).toHaveLength(2);
	});

	it("relocates the third-party system prompt into the first user message", () => {
		const result = parse(
			transformClaudeOAuthBody(dispatchBody("You are Dispatch. Use tools.", "do the thing")),
		);
		const sys = result.system ?? [];
		// The system prompt must NOT appear anywhere in system[].
		expect(sys.some((b) => b.text.includes("You are Dispatch"))).toBe(false);
		// It is prepended to the first user message.
		expect(result.messages?.[0]?.content).toBe("You are Dispatch. Use tools.\n\ndo the thing");
	});

	it("prepends a text block when the first user message uses array content", () => {
		const body = JSON.stringify({
			system: [
				{
					type: "text",
					text: `${BILLING}\n${IDENTITY}\n\nDispatch instructions here.`,
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [{ role: "user", content: [{ type: "text", text: "user text" }] }],
		});
		const result = parse(transformClaudeOAuthBody(body));
		const content = result.messages?.[0]?.content as Array<{ type: string; text: string }>;
		expect(content[0]).toEqual({ type: "text", text: "Dispatch instructions here." });
		expect(content[1]).toEqual({ type: "text", text: "user text" });
	});

	it("does not carry cache_control to the identity when the source had none", () => {
		const body = JSON.stringify({
			system: [{ type: "text", text: `${BILLING}\n${IDENTITY}\n\nInstr.` }],
			messages: [{ role: "user", content: "hi" }],
		});
		const result = parse(transformClaudeOAuthBody(body));
		expect(result.system?.[1]?.cache_control).toBeUndefined();
	});

	it("keeps the prompt as a cached system block when there is no user message", () => {
		const body = JSON.stringify({
			system: [
				{
					type: "text",
					text: `${BILLING}\n${IDENTITY}\n\nInstr only.`,
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [],
		});
		const result = parse(transformClaudeOAuthBody(body));
		const sys = result.system ?? [];
		expect(sys[0]?.text).toBe(BILLING);
		expect(sys[1]?.text).toBe(IDENTITY);
		expect(sys[2]?.text).toBe("Instr only.");
		expect(sys[2]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("leaves non-Claude-Code bodies (no identity string) untouched", () => {
		const body = JSON.stringify({
			system: [{ type: "text", text: "Some unrelated system prompt." }],
			messages: [{ role: "user", content: "hi" }],
		});
		// Returned unchanged (same reference string, byte-identical).
		expect(transformClaudeOAuthBody(body)).toBe(body);
	});

	it("returns non-string bodies unchanged", () => {
		const buf = new Uint8Array([1, 2, 3]);
		expect(transformClaudeOAuthBody(buf)).toBe(buf);
		expect(transformClaudeOAuthBody(undefined)).toBeUndefined();
		expect(transformClaudeOAuthBody(null)).toBeNull();
	});

	it("returns invalid JSON unchanged", () => {
		const garbage = "{not json";
		expect(transformClaudeOAuthBody(garbage)).toBe(garbage);
	});

	it("never emits more than the 4 cache_control breakpoints Anthropic allows", () => {
		const result = parse(transformClaudeOAuthBody(dispatchBody("Big system prompt.")));
		const all = result.system ?? [];
		const cacheBlocks = all.filter((b) => b.cache_control != null);
		// Only the identity block is marked here — well under the limit of 4.
		expect(cacheBlocks.length).toBeLessThanOrEqual(4);
	});
});
