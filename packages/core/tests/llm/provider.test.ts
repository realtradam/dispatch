import { describe, expect, it, vi } from "vitest";

// Mock @ai-sdk/anthropic to capture what options createAnthropic is called with
const mockAnthropicInstance = vi.fn((modelId: string) => ({
	specificationVersion: "v3" as const,
	provider: "anthropic.messages",
	modelId,
	supportedUrls: {},
	doGenerate: vi.fn(),
	doStream: vi.fn(),
}));
const mockCreateAnthropic = vi.fn(() => mockAnthropicInstance);
vi.mock("@ai-sdk/anthropic", () => ({
	createAnthropic: mockCreateAnthropic,
}));

// Mock @ai-sdk/openai-compatible to capture what options createOpenAICompatible
// is called with, and what model id the returned factory is called with.
const mockOpenAICompatibleFactory = vi.fn((modelId: string) => ({
	specificationVersion: "v3" as const,
	provider: "openai-compatible",
	modelId,
	supportedUrls: {},
	doGenerate: vi.fn(),
	doStream: vi.fn(),
}));
const mockCreateOpenAICompatible = vi.fn(() => mockOpenAICompatibleFactory);
vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: mockCreateOpenAICompatible,
}));

const { createProvider } = await import("../../src/llm/provider.js");

describe("createProvider (default OpenAI-compatible path)", () => {
	it("does not wrap the model in a middleware layer — v6 SDK handles reasoning round-trip natively", () => {
		mockCreateOpenAICompatible.mockClear();
		mockOpenAICompatibleFactory.mockClear();

		const model = createProvider({
			apiKey: "test-key",
			baseURL: "https://example.com/v1",
		})("deepseek-v4-pro");

		// The factory should have been invoked with the model id directly,
		// without going through `wrapLanguageModel`. If a middleware were
		// still in place, the returned object would carry an `_middleware`
		// property (set by our test mock pattern). The bare provider model
		// has no such property — verifying the v4-era normalizeMessages
		// middleware is gone.
		expect(mockOpenAICompatibleFactory).toHaveBeenCalledWith("deepseek-v4-pro");
		expect((model as { _middleware?: unknown })._middleware).toBeUndefined();
	});

	it("passes name, apiKey, baseURL to createOpenAICompatible", () => {
		mockCreateOpenAICompatible.mockClear();

		createProvider({
			apiKey: "zen-key",
			baseURL: "https://opencode.ai/zen/v1",
		})("deepseek-v4-pro");

		expect(mockCreateOpenAICompatible).toHaveBeenCalledWith({
			name: "opencode-zen",
			apiKey: "zen-key",
			baseURL: "https://opencode.ai/zen/v1",
		});
	});
});

describe("createClaudeOAuthProvider", () => {
	it("passes authToken (not apiKey) to createAnthropic for OAuth flow", () => {
		mockCreateAnthropic.mockClear();

		createProvider({
			provider: "anthropic",
			apiKey: "fallback-api-key",
			baseURL: "",
			claudeCredentials: { accessToken: "oauth-access-token" },
		})("claude-opus-4-5");

		expect(mockCreateAnthropic).toHaveBeenCalledOnce();
		const callArgs = mockCreateAnthropic.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(callArgs.authToken).toBe("oauth-access-token");
		expect(callArgs.apiKey).toBeUndefined();
	});

	it("falls back to apiKey as authToken when claudeCredentials are absent", () => {
		mockCreateAnthropic.mockClear();

		createProvider({
			provider: "anthropic",
			apiKey: "sk-ant-api-key",
			baseURL: "",
		})("claude-opus-4-5");

		expect(mockCreateAnthropic).toHaveBeenCalledOnce();
		const callArgs = mockCreateAnthropic.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(callArgs.authToken).toBe("sk-ant-api-key");
		expect(callArgs.apiKey).toBeUndefined();
	});

	it("includes required Claude CLI headers", () => {
		mockCreateAnthropic.mockClear();

		createProvider({
			provider: "anthropic",
			apiKey: "test-key",
			baseURL: "",
			claudeCredentials: { accessToken: "tok" },
		})("claude-opus-4-5");

		const callArgs = mockCreateAnthropic.mock.calls[0]?.[0] as Record<
			string,
			Record<string, string>
		>;
		expect(callArgs.headers?.["anthropic-dangerous-direct-browser-access"]).toBe("true");
		expect(callArgs.headers?.["x-app"]).toBe("cli");
		expect(callArgs.headers?.["user-agent"]).toMatch(/claude-cli/);
	});

	it("installs a fetch wrapper that restructures the body and stamps Claude Code session headers", async () => {
		mockCreateAnthropic.mockClear();

		// Capture what global fetch receives after the wrapper runs.
		const globalFetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		const prevFetch = globalThis.fetch;
		globalThis.fetch = globalFetchMock as unknown as typeof fetch;
		try {
			createProvider({
				provider: "anthropic",
				apiKey: "test-key",
				baseURL: "",
				claudeCredentials: { accessToken: "tok" },
			})("claude-opus-4-8");

			const callArgs = mockCreateAnthropic.mock.calls[0]?.[0] as { fetch?: typeof fetch };
			expect(typeof callArgs.fetch).toBe("function");

			const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
			const BILLING =
				"x-anthropic-billing-header: cc_version=2.1.112.x; cc_entrypoint=sdk-cli; cch=abcde;";
			const body = JSON.stringify({
				system: [
					{
						type: "text",
						text: `${BILLING}\n${IDENTITY}\n\nDispatch system prompt.`,
						cache_control: { type: "ephemeral" },
					},
				],
				messages: [{ role: "user", content: "hi there" }],
			});

			await callArgs.fetch?.("https://api.anthropic.com/v1/messages", {
				method: "POST",
				body,
				headers: { "content-type": "application/json" },
			});

			expect(globalFetchMock).toHaveBeenCalledOnce();
			const [, init] = globalFetchMock.mock.calls[0] as unknown as [unknown, RequestInit];

			// Body was restructured: billing isolated, third-party prompt moved to user msg.
			const sent = JSON.parse(init.body as string) as {
				system: Array<{ text: string; cache_control?: unknown }>;
				messages: Array<{ content: string }>;
			};
			expect(sent.system).toHaveLength(2);
			expect(sent.system[0]?.text).toBe(BILLING);
			expect(sent.system[0]?.cache_control).toBeUndefined();
			expect(sent.system[1]?.text).toBe(IDENTITY);
			expect(sent.messages[0]?.content).toBe("Dispatch system prompt.\n\nhi there");

			// Claude Code session headers were stamped.
			const headers = new Headers(init.headers);
			expect(headers.get("X-Claude-Code-Session-Id")).toBeTruthy();
			expect(headers.get("x-client-request-id")).toBeTruthy();
		} finally {
			globalThis.fetch = prevFetch;
		}
	});

	it("sends the anthropic-beta header so prompt-caching is honored (claude-report.md Root Cause 1)", () => {
		// Without `anthropic-beta: ...,prompt-caching-scope-2026-01-05,...` the
		// Anthropic API silently ignores every `cache_control` marker we attach
		// to messages, producing a 0% cache hit rate. `@ai-sdk/anthropic` does
		// NOT inject this beta on its own — it only derives betas from tool
		// definitions — so the OAuth provider MUST set it on its config headers.
		mockCreateAnthropic.mockClear();

		createProvider({
			provider: "anthropic",
			apiKey: "test-key",
			baseURL: "",
			claudeCredentials: { accessToken: "tok" },
		})("claude-opus-4-5");

		const callArgs = mockCreateAnthropic.mock.calls[0]?.[0] as Record<
			string,
			Record<string, string>
		>;
		const betaHeader = callArgs.headers?.["anthropic-beta"];
		expect(betaHeader).toBeDefined();
		const betas = (betaHeader ?? "").split(",").map((b) => b.trim());
		// The load-bearing caching + oauth betas must be present.
		expect(betas).toContain("prompt-caching-scope-2026-01-05");
		expect(betas).toContain("oauth-2025-04-20");
	});

	it("uses default Anthropic baseURL when none provided", () => {
		mockCreateAnthropic.mockClear();

		createProvider({
			provider: "anthropic",
			apiKey: "test-key",
			baseURL: "",
			claudeCredentials: { accessToken: "tok" },
		})("claude-opus-4-5");

		const callArgs = mockCreateAnthropic.mock.calls[0]?.[0] as Record<string, string>;
		expect(callArgs.baseURL).toBe("https://api.anthropic.com/v1");
	});

	it("uses configured baseURL when provided", () => {
		mockCreateAnthropic.mockClear();

		createProvider({
			provider: "anthropic",
			apiKey: "test-key",
			baseURL: "https://custom.proxy.example.com/v1",
			claudeCredentials: { accessToken: "tok" },
		})("claude-opus-4-5");

		const callArgs = mockCreateAnthropic.mock.calls[0]?.[0] as Record<string, string>;
		expect(callArgs.baseURL).toBe("https://custom.proxy.example.com/v1");
	});
});

describe("createApiKeyAnthropicProvider", () => {
	it("passes apiKey (not authToken) to createAnthropic", () => {
		mockCreateAnthropic.mockClear();

		createProvider({
			provider: "opencode-anthropic",
			apiKey: "zen-api-key",
			baseURL: "",
		})("minimax-model");

		expect(mockCreateAnthropic).toHaveBeenCalledOnce();
		const callArgs = mockCreateAnthropic.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(callArgs.apiKey).toBe("zen-api-key");
		expect(callArgs.authToken).toBeUndefined();
	});

	it("uses default OpenCode Zen baseURL when none provided", () => {
		mockCreateAnthropic.mockClear();

		createProvider({
			provider: "opencode-anthropic",
			apiKey: "zen-api-key",
			baseURL: "",
		})("minimax-model");

		const callArgs = mockCreateAnthropic.mock.calls[0]?.[0] as Record<string, string>;
		expect(callArgs.baseURL).toBe("https://opencode.ai/zen/go/v1");
	});
});
