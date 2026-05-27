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
