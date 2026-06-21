import { createLogger, type HostAPI, type ToolExecuteContext } from "@dispatch/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate, extension, manifest } from "./extension.js";

function stubCtx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
	return {
		toolCallId: "test-call-1",
		onOutput: () => {},
		signal: new AbortController().signal,
		log: createLogger(
			{ extensionId: "test" },
			{ emit: () => {} },
			{ now: () => 0, newId: () => "id" },
		),
		...overrides,
	};
}

function makeFakeHost(): { host: HostAPI; defineTool: ReturnType<typeof vi.fn> } {
	const defineTool = vi.fn();
	const host = {
		defineTool,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			span: vi.fn(() => ({ end: vi.fn() })),
		},
	} as unknown as HostAPI;
	return { host, defineTool };
}

const ORIG_FETCH = globalThis.fetch;
const ORIG_ENV = process.env.FIRECRAWL_BASE_URL;

function restoreEnv(): void {
	if (ORIG_ENV === undefined) {
		delete process.env.FIRECRAWL_BASE_URL;
	} else {
		process.env.FIRECRAWL_BASE_URL = ORIG_ENV;
	}
}

afterEach(() => {
	globalThis.fetch = ORIG_FETCH;
	restoreEnv();
});

function stubFetchCapture(): { calls: Array<{ url: string }> } {
	const calls: Array<{ url: string }> = [];
	globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
		calls.push({ url: String(input) });
		return new Response(JSON.stringify({ success: true, data: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof globalThis.fetch;
	return { calls };
}

describe("tool-web-search activation", () => {
	it("registers the 'web_search' tool (defineTool called)", () => {
		const { host, defineTool } = makeFakeHost();
		activate(host);
		expect(defineTool).toHaveBeenCalledTimes(1);
		const registered = defineTool.mock.calls[0]?.[0];
		if (!registered) throw new Error("no tool registered");
		expect(registered.name).toBe("web_search");
		expect(registered.concurrencySafe).toBe(true);
	});

	it("uses FIRECRAWL_BASE_URL from env", async () => {
		process.env.FIRECRAWL_BASE_URL = "http://env-firecrawl.local/v1";
		const { calls } = stubFetchCapture();
		const { host, defineTool } = makeFakeHost();
		activate(host);

		const tool = defineTool.mock.calls[0]?.[0];
		if (!tool) throw new Error("no tool registered");
		await tool.execute({ query: "hello" }, stubCtx());
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]?.url).toContain("http://env-firecrawl.local/v1/search");
	});

	it("uses default base URL when env unset", async () => {
		delete process.env.FIRECRAWL_BASE_URL;
		const { calls } = stubFetchCapture();
		const { host, defineTool } = makeFakeHost();
		activate(host);

		const tool = defineTool.mock.calls[0]?.[0];
		if (!tool) throw new Error("no tool registered");
		await tool.execute({ query: "hello" }, stubCtx());
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]?.url).toContain("100.102.55.49:31329/v1/search");
	});
});

describe("tool-web-search manifest", () => {
	it("declares network capability + web_search contribution", () => {
		expect(manifest.id).toBe("tool-web-search");
		expect(manifest.capabilities).toEqual({ network: true });
		expect(manifest.contributes).toEqual({ tools: ["web_search"] });
		expect(manifest.trust).toBe("bundled");
		expect(manifest.activation).toBe("eager");
	});

	it("extension bundles the manifest + activate", () => {
		expect(extension.manifest).toBe(manifest);
		expect(typeof extension.activate).toBe("function");
	});
});
