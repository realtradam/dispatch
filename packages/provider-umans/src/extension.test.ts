import type { ChatMessage, HostAPI, ProviderContract, ProviderEvent } from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import { activate, manifest } from "./extension.js";
import type { EnvSource } from "./resolver.js";

function makeFakeHost(overrides: { configGet?: (key: string) => unknown }): {
  host: HostAPI;
  defineProvider: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  const defineProvider = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const host = {
    defineProvider,
    config: { get: overrides.configGet ?? (() => undefined) },
    logger: { debug: vi.fn(), info, warn, error: vi.fn() },
  } as unknown as HostAPI;
  return { host, defineProvider, warn, info };
}

describe("provider-umans activation", () => {
  it('activate registers the "umans" provider when UMANS_API_KEY is set (defineProvider called with id "umans")', async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { UMANS_API_KEY: "sk-test" };

    await activate(host, env);

    expect(defineProvider).toHaveBeenCalledTimes(1);
    expect(defineProvider.mock.calls[0]?.[0]?.id).toBe("umans");
  });

  it("activate does NOT register + warns when UMANS_API_KEY is unset", async () => {
    const { host, defineProvider, warn } = makeFakeHost({});
    const env: EnvSource = {};

    await activate(host, env);

    expect(defineProvider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("provider-umans: no UMANS_API_KEY. Provider not registered.");
  });

  it("declares no dependsOn (self-contained, reads env directly)", () => {
    expect(manifest.dependsOn).toBeUndefined();
  });

  it("declares the umans provider contribution + network capability", () => {
    expect(manifest.contributes?.providers).toEqual(["umans"]);
    expect(manifest.capabilities?.network).toBe(true);
    expect(manifest.tier).toBe("providers");
  });
});

describe("provider-umans image-count cap", () => {
  function sseOk(): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"id":"cmpl-u1","choices":[{"delta":{"content":"ok"},"index":0}]}\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"id":"cmpl-u1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    for await (const event of iter) events.push(event);
    return events;
  }

  it("sends at most 8 image_url parts: 10 images → 8 parts + 2 placeholders", async () => {
    const { host, defineProvider } = makeFakeHost({});
    await activate(host, { UMANS_API_KEY: "sk-test" });

    const provider = defineProvider.mock.calls[0]?.[0] as ProviderContract | undefined;
    if (provider === undefined) throw new Error("provider not registered");

    let sentBody: {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    } = { messages: [] };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as typeof sentBody;
      return sseOk();
    }) as unknown as typeof globalThis.fetch;

    try {
      const messages: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
        role: "user",
        chunks: [{ type: "image", url: `data:image/png;base64,AAAA${i}` }],
      }));

      const events = await collect(provider.stream(messages, []));
      expect(events.some((event) => event.type === "finish")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const imageParts = sentBody.messages.flatMap((message) =>
      message.content.filter((part) => part.type === "image_url"),
    );
    const placeholders = sentBody.messages.flatMap((message) =>
      message.content.filter(
        (part) => part.type === "text" && (part.text ?? "").includes("[image omitted"),
      ),
    );

    expect(imageParts).toHaveLength(8);
    expect(placeholders).toHaveLength(2);
  });
});
