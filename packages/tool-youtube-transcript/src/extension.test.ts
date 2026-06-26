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
const ORIG_ENV = process.env.YOUTUBE_TRANSCRIBER_URL;

function restoreEnv(): void {
  if (ORIG_ENV === undefined) {
    delete process.env.YOUTUBE_TRANSCRIBER_URL;
  } else {
    process.env.YOUTUBE_TRANSCRIBER_URL = ORIG_ENV;
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
    return new Response(
      JSON.stringify({
        status: "completed",
        video_id: "v",
        full_text: "",
        segments: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { calls };
}

describe("tool-youtube-transcript activation", () => {
  it("registers the 'youtube_transcript' tool (defineTool called)", () => {
    const { host, defineTool } = makeFakeHost();
    activate(host);
    expect(defineTool).toHaveBeenCalledTimes(1);
    const registered = defineTool.mock.calls[0]?.[0];
    if (!registered) throw new Error("no tool registered");
    expect(registered.name).toBe("youtube_transcript");
    expect(registered.concurrencySafe).toBe(true);
  });

  it("uses YOUTUBE_TRANSCRIBER_URL from env", async () => {
    process.env.YOUTUBE_TRANSCRIBER_URL = "http://env-transcriber.local";
    const { calls } = stubFetchCapture();
    const { host, defineTool } = makeFakeHost();
    activate(host);

    const tool = defineTool.mock.calls[0]?.[0];
    if (!tool) throw new Error("no tool registered");
    await tool.execute({ url: "https://youtu.be/vid1" }, stubCtx());
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.url).toContain("http://env-transcriber.local/api/transcript?url=");
  });

  it("uses default base URL when env unset", async () => {
    delete process.env.YOUTUBE_TRANSCRIBER_URL;
    const { calls } = stubFetchCapture();
    const { host, defineTool } = makeFakeHost();
    activate(host);

    const tool = defineTool.mock.calls[0]?.[0];
    if (!tool) throw new Error("no tool registered");
    await tool.execute({ url: "https://youtu.be/vid1" }, stubCtx());
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.url).toContain("100.102.55.49:41090/api/transcript?url=");
  });
});

describe("tool-youtube-transcript manifest", () => {
  it("declares network capability + youtube_transcript contribution", () => {
    expect(manifest.id).toBe("tool-youtube-transcript");
    expect(manifest.capabilities).toEqual({ network: true });
    expect(manifest.contributes).toEqual({ tools: ["youtube_transcript"] });
    expect(manifest.trust).toBe("bundled");
    expect(manifest.activation).toBe("eager");
  });

  it("extension bundles the manifest + activate", () => {
    expect(extension.manifest).toBe(manifest);
    expect(typeof extension.activate).toBe("function");
  });
});
