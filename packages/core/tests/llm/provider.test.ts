import { describe, expect, it, vi } from "vitest";

// We test normalizeMessages through the middleware by mocking the provider
// layers and capturing what transformParams does to the prompt.

// Mock wrapLanguageModel to capture the middleware
vi.mock("ai", async () => {
	const actual = await import("ai");
	return {
		...actual,
		wrapLanguageModel: vi.fn(({ model, middleware }) => {
			// Return a wrapper that exposes the middleware for testing
			const wrapped = actual.wrapLanguageModel({ model, middleware });
			(wrapped as unknown as Record<string, unknown>)._middleware = middleware;
			return wrapped;
		}),
		streamText: vi.fn(),
	};
});

// Mock provider factory
vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => (modelId: string) => ({
		id: `mock-${modelId}`,
		doGenerate: vi.fn(),
		doStream: vi.fn(),
	})),
}));

const { createProvider } = await import("../../src/llm/provider.js");

// A helper that runs the middleware's transformParams on a prompt
// and returns the resulting normalized prompt.
async function runTransform(
	prompt: unknown[],
): Promise<unknown[]> {
	const wrappedModel = createProvider({
		apiKey: "test-key",
		baseURL: "https://example.com/v1",
	})("test-model");

	const middleware = (
		(wrappedModel as unknown) as { _middleware: Array<{ transformParams: (args: { type: string; params: Record<string, unknown> }) => Promise<unknown> }> }
	)._middleware;

	const result = await middleware[0]!.transformParams({
		type: "stream",
		params: { prompt },
	});

	return (result as Record<string, unknown>).prompt as unknown[];
}

describe("createProvider middleware", () => {
	it("passes through non-stream calls unchanged", async () => {
		const wrappedModel = createProvider({
			apiKey: "test-key",
			baseURL: "https://example.com/v1",
		})("test-model");

		const middleware = (
			(wrappedModel as unknown) as { _middleware: Array<{ transformParams: (args: { type: string; params: Record<string, unknown> }) => Promise<unknown> }> }
		)._middleware;

		const params = { prompt: [], temperature: 0.5 };
		const result = (await middleware[0]!.transformParams({
			type: "generate",
			params,
		})) as Record<string, unknown>;

		expect(result).toEqual(params);
	});

	it("strips reasoning parts and sets reasoning_content on providerMetadata", async () => {
		const prompt = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "I should use the list_files tool." },
					{ type: "text", text: "Let me check the directory." },
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "list_files",
						args: { path: "." },
					},
				],
			},
		];

		const normalized = await runTransform(prompt);
		const msg = normalized[0] as Record<string, unknown>;

		// Reasoning parts removed from content
		const content = msg.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(2);
		expect(content.find((p) => p.type === "reasoning")).toBeUndefined();
		expect(content.find((p) => p.type === "text")).toBeDefined();
		expect(content.find((p) => p.type === "tool-call")).toBeDefined();

		// reasoning_content set on providerMetadata
		const pm = msg.providerMetadata as Record<string, unknown>;
		const compat = pm.openaiCompatible as Record<string, unknown>;
		expect(compat.reasoning_content).toBe("I should use the list_files tool.");
	});

	it("sets empty reasoning_content when no reasoning parts exist", async () => {
		const prompt = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Hello!" },
				],
			},
		];

		const normalized = await runTransform(prompt);
		const msg = normalized[0] as Record<string, unknown>;

		// Content unchanged
		const content = msg.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(1);
		expect(content[0]!.type).toBe("text");

		// reasoning_content always set, even empty
		const pm = msg.providerMetadata as Record<string, unknown>;
		const compat = pm.openaiCompatible as Record<string, unknown>;
		expect(compat.reasoning_content).toBe("");
	});

	it("does not modify user messages", async () => {
		const prompt = [
			{
				role: "user",
				content: [{ type: "text", text: "What dir am I in?" }],
			},
		];

		const normalized = await runTransform(prompt);
		expect(normalized).toEqual(prompt);
	});

	it("does not modify system messages", async () => {
		const prompt = [
			{ role: "system", content: "You are a helpful assistant." },
		];

		const normalized = await runTransform(prompt);
		expect(normalized).toEqual(prompt);
	});

	it("handles assistant with plain string content (not array)", async () => {
		const prompt = [
			{
				role: "assistant",
				content: "Hello world",
			},
		];

		const normalized = await runTransform(prompt);
		expect(normalized).toEqual(prompt);
	});

	it("handles redacted-reasoning type parts", async () => {
		const prompt = [
			{
				role: "assistant",
				content: [
					{ type: "redacted-reasoning", text: "[redacted chain of thought]" },
					{ type: "text", text: "Here is the result." },
				],
			},
		];

		const normalized = await runTransform(prompt);
		const msg = normalized[0] as Record<string, unknown>;

		const content = msg.content as Array<Record<string, unknown>>;
		expect(content.find((p) => p.type === "redacted-reasoning")).toBeUndefined();
		expect(content.find((p) => p.type === "text")).toBeDefined();

		const pm = msg.providerMetadata as Record<string, unknown>;
		const compat = pm.openaiCompatible as Record<string, unknown>;
		expect(compat.reasoning_content).toBe("[redacted chain of thought]");
	});

	it("preserves existing providerMetadata fields", async () => {
		const prompt = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "thinking..." },
					{ type: "text", text: "done" },
				],
				providerMetadata: {
					openaiCompatible: { custom_field: "keep-me" },
				},
			},
		];

		const normalized = await runTransform(prompt);
		const msg = normalized[0] as Record<string, unknown>;
		const pm = msg.providerMetadata as Record<string, unknown>;
		const compat = pm.openaiCompatible as Record<string, unknown>;

		expect(compat.custom_field).toBe("keep-me");
		expect(compat.reasoning_content).toBe("thinking...");
	});

	it("handles multi-message prompts with mixed roles", async () => {
		const prompt = [
			{ role: "system", content: "Be helpful." },
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "I'll say hello." },
					{ type: "text", text: "Hi there!" },
				],
			},
		];

		const normalized = await runTransform(prompt);

		// System and user unchanged
		expect(normalized[0]).toEqual(prompt[0]);
		expect(normalized[1]).toEqual(prompt[1]);

		// Assistant transformed
		const msg = normalized[2] as Record<string, unknown>;
		const pm = msg.providerMetadata as Record<string, unknown>;
		const compat = pm.openaiCompatible as Record<string, unknown>;
		expect(compat.reasoning_content).toBe("I'll say hello.");
	});

	it("concatenates multiple reasoning parts", async () => {
		const prompt = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "Step 1: " },
					{ type: "reasoning", text: "Step 2: " },
					{ type: "reasoning", text: "Step 3." },
					{ type: "text", text: "Final answer." },
				],
			},
		];

		const normalized = await runTransform(prompt);
		const msg = normalized[0] as Record<string, unknown>;
		const pm = msg.providerMetadata as Record<string, unknown>;
		const compat = pm.openaiCompatible as Record<string, unknown>;
		expect(compat.reasoning_content).toBe("Step 1: Step 2: Step 3.");
	});

	it("applies to every assistant message in a multi-step history", async () => {
		const prompt = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "First thought." },
					{ type: "tool-call", toolCallId: "c1", toolName: "list_files", args: {} },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "Second thought." },
					{ type: "text", text: "All done." },
				],
			},
		];

		const normalized = await runTransform(prompt);

		const msg1 = normalized[0] as Record<string, unknown>;
		const compat1 = (msg1.providerMetadata as Record<string, unknown>).openaiCompatible as Record<string, unknown>;
		expect(compat1.reasoning_content).toBe("First thought.");

		const msg2 = normalized[1] as Record<string, unknown>;
		const compat2 = (msg2.providerMetadata as Record<string, unknown>).openaiCompatible as Record<string, unknown>;
		expect(compat2.reasoning_content).toBe("Second thought.");
	});
});
