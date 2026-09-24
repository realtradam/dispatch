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

function makeFakeHost(overrides?: { configGet?: (key: string) => unknown }): {
  host: HostAPI;
  defineTool: ReturnType<typeof vi.fn>;
  provided: Map<string, unknown>;
} {
  const defineTool = vi.fn();
  const provided = new Map<string, unknown>();
  const host = {
    defineTool,
    provideService: vi.fn((handle: { id?: string }, service: unknown) => {
      provided.set(String(handle.id ?? "unknown"), service);
    }),
    storage: vi.fn(() => {
      const map = new Map<string, string>();
      return {
        get: async (key: string) => map.get(key) ?? null,
        set: async (key: string, value: string) => {
          map.set(key, value);
        },
        keys: async () => [...map.keys()],
      };
    }),
    config: {
      get: overrides?.configGet ?? (() => undefined),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      span: vi.fn(() => ({ end: vi.fn() })),
    },
  } as unknown as HostAPI;
  return { host, defineTool, provided };
}

const ORIG_FETCH = globalThis.fetch;
const ORIG_ENV = process.env.FIRECRAWL_BASE_URL;
const ORIG_UMANS_KEY = process.env.UMANS_API_KEY;
const ORIG_UMANS_BASE = process.env.UMANS_BASE_URL;

function restoreEnv(): void {
  if (ORIG_ENV === undefined) {
    delete process.env.FIRECRAWL_BASE_URL;
  } else {
    process.env.FIRECRAWL_BASE_URL = ORIG_ENV;
  }
  if (ORIG_UMANS_KEY === undefined) {
    delete process.env.UMANS_API_KEY;
  } else {
    process.env.UMANS_API_KEY = ORIG_UMANS_KEY;
  }
  if (ORIG_UMANS_BASE === undefined) {
    delete process.env.UMANS_BASE_URL;
  } else {
    process.env.UMANS_BASE_URL = ORIG_UMANS_BASE;
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
    expect(calls[0]?.url).toContain("PII_REDACTED_SERVICE_IPV4_01:31329/v1/search");
  });
});

describe("tool-web-search search-backend selection wiring", () => {
  it("provides the search-config service and defaults to firecrawl", async () => {
    delete process.env.UMANS_API_KEY;
    const { host, provided } = makeFakeHost();
    activate(host);
    const svc = provided.get("search-config") as {
      getConfig: () => Promise<{ backend: string; available: Array<{ id: string }> }>;
    };
    if (svc === undefined) throw new Error("search-config service not provided");
    const config = await svc.getConfig();
    expect(config.backend).toBe("firecrawl");
    expect(config.available.map((b) => b.id)).toEqual(["firecrawl"]);
  });

  it("lists umans as configured when UMANS_API_KEY is set", async () => {
    process.env.UMANS_API_KEY = "test-key";
    const { host, provided } = makeFakeHost();
    activate(host);
    const svc = provided.get("search-config") as {
      getConfig: () => Promise<{
        backend: string;
        available: Array<{ id: string; configured: boolean }>;
      }>;
    };
    const config = await svc.getConfig();
    expect(config.available.map((b) => b.id)).toEqual(["firecrawl", "umans"]);
    expect(config.available[1]?.configured).toBe(true);
  });

  it("search mode honors the selected backend; scrape routes to Firecrawl regardless", async () => {
    process.env.UMANS_API_KEY = "test-key";
    process.env.UMANS_BASE_URL = "http://umans-relay.local/v1";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, init });
      if (url.includes("umans-relay.local")) {
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "web_search_tool_result",
                content: [
                  { type: "web_search_result", url: "http://a", title: "A", snippet: "sa" },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ success: true, data: [{ title: "F" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const { host, defineTool, provided } = makeFakeHost();
    activate(host);
    const tool = defineTool.mock.calls[0]?.[0] as {
      execute: (
        args: unknown,
        ctx: ToolExecuteContext,
      ) => Promise<{ content: string; isError?: boolean }>;
    };
    const svc = provided.get("search-config") as {
      updateConfig: (patch: { backend: string }) => Promise<unknown>;
    };

    // Default (firecrawl): search hits Firecrawl.
    const viaFirecrawl = await tool.execute({ query: "hello" }, stubCtx());
    expect(viaFirecrawl.isError).toBeFalsy();
    expect(calls[0]?.url).toContain("/search");

    // Switch to umans: search relays to Umans and returns hits-only output.
    const updated = await svc.updateConfig({ backend: "umans" });
    expect(updated).toMatchObject({ ok: true });
    const viaUmans = await tool.execute({ query: "hello" }, stubCtx());
    expect(viaUmans.isError).toBeFalsy();
    expect(viaUmans.content).toContain("### A");
    expect(calls.at(-1)?.url).toContain("umans-relay.local/v1/messages");

    // Scrape ALWAYS routes to Firecrawl, even with umans selected.
    calls.length = 0;
    const scrape = await tool.execute({ url: "http://x", mode: "scrape" }, stubCtx());
    expect(scrape.isError).toBeFalsy();
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain("/scrape");

    // "none": search refuses cleanly (isError), scrape still works.
    await svc.updateConfig({ backend: "none" });
    const none = await tool.execute({ query: "hello" }, stubCtx());
    expect(none.isError).toBe(true);
    expect(none.content).toContain("search is disabled");
    const scrapeStillWorks = await tool.execute({ url: "http://x", mode: "scrape" }, stubCtx());
    expect(scrapeStillWorks.isError).toBeFalsy();
  });
});

describe("tool-web-search manifest", () => {
  it("declares network capability + web_search contribution", () => {
    expect(manifest.id).toBe("tool-web-search");
    expect(manifest.capabilities).toEqual({ network: true });
    expect(manifest.contributes).toEqual({ tools: ["web_search"], services: ["search-config"] });
    expect(manifest.trust).toBe("bundled");
    expect(manifest.activation).toBe("eager");
  });

  it("extension bundles the manifest + activate", () => {
    expect(extension.manifest).toBe(manifest);
    expect(typeof extension.activate).toBe("function");
  });
});
