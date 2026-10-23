import {
  createBus,
  createHost,
  createLogger,
  type Extension,
  type HostDeps,
  type LogRecord,
} from "@dispatch/kernel";

/** Real kernel host, deterministic in-memory logging and explicit unused effects. */
export function incoTestHost(
  extensions: readonly Extension[],
  key: string | null = "fake-inco-test-key",
  config: Readonly<Record<string, unknown>> = {},
) {
  const records: LogRecord[] = [];
  let nextId = 0;
  const logDeps = { now: () => 1, newId: () => `test-${++nextId}` };
  const logSink = { emit: (record: LogRecord) => records.push(record) };
  const logger = createLogger({ extensionId: "test" }, logSink, logDeps);
  const secretReads: string[] = [];
  const deps: HostDeps = {
    logger,
    logSink,
    logDeps,
    bus: createBus(logger),
    config: {
      get: <T>(name: string) => config[name] as T | undefined,
      getAll: () => config,
    },
    secrets: {
      get: async (name) => {
        secretReads.push(name);
        return key;
      },
      set: async () => {},
      delete: async () => {},
    },
    storageFactory: () => {
      throw new Error("Inco must not use storage");
    },
    permissions: { check: async () => ({ allowed: true }) },
    events: { emit: () => {} },
    scheduler: { register: () => {}, unregister: () => {} },
  };
  return { host: createHost(extensions, deps), records, secretReads, logger };
}

import type { ChatMessage, ProviderEvent, ToolContract } from "@dispatch/kernel";
import { verifyPlugin } from "@dispatch/plugin-verify";
import { describe, expect, it } from "vitest";
import { createIncoExtension, INCO_DEFAULT_MODEL, manifest } from "./index.js";
import { type IncoFetch, maskIncoSecret } from "./logging.js";

const messages: readonly ChatMessage[] = [
  { role: "user", chunks: [{ type: "text", text: "hello" }] },
];
const tool: ToolContract = {
  name: "lookup",
  description: "Look up a value",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  concurrencySafe: true,
  execute: async () => ({ content: "found" }),
};
async function collect(events: AsyncIterable<ProviderEvent>) {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function sse(parts: readonly unknown[]) {
  return new Response(
    `${parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}
function textResponse() {
  return sse([
    { choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] },
    { choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] },
    {
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    },
  ]);
}
async function registered(fetchFn: IncoFetch, config: Readonly<Record<string, unknown>> = {}) {
  const setup = incoTestHost([createIncoExtension({ fetchFn })], "fake-inco-test-key", config);
  await setup.host.activate();
  const provider = setup.host.getProvider("inco");
  if (!provider) throw new Error("Missing inco provider");
  return { ...setup, provider };
}

it("declares a truthful bundled providers-tier manifest", () => {
  expect(manifest).toMatchObject({
    id: "provider-inco",
    tier: "providers",
    trust: "bundled",
    contributes: { providers: ["inco"] },
    capabilities: { network: true, secrets: true },
  });
  expect(manifest).not.toHaveProperty("dependsOn");
});
it.each([null, "", "  "])("no key %j leaves real host inert without network", async (key) => {
  let calls = 0;
  const { host, secretReads } = incoTestHost(
    [
      createIncoExtension({
        fetchFn: async () => {
          calls++;
          return textResponse();
        },
      }),
    ],
    key,
  );
  await host.activate();
  expect(host.getProviders().size).toBe(0);
  expect(secretReads).toEqual(["INCO_API_KEY"]);
  expect(calls).toBe(0);
  await host.deactivate();
});
it("registers inco, omits getUsage, sends authenticated default :fast SSE and parses text/reasoning/usage", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const { provider, records, host } = await registered(async (url, init) => {
    requests.push({ url: String(url), init });
    return textResponse();
  });
  expect(provider).not.toHaveProperty("getUsage");
  const events = await collect(provider.stream(messages, [], { reasoningEffort: "low" }));
  expect(events).toContainEqual({ type: "text-delta", delta: "hello" });
  expect(events).toContainEqual({ type: "reasoning-delta", delta: "thinking" });
  expect(events).toContainEqual({
    type: "usage",
    usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 },
  });
  expect(events).toContainEqual({ type: "finish", reason: "stop" });
  const request = requests[0];
  if (!request) throw new Error("Missing request");
  expect(request.url).toBe("https://api.inco.ai/v1/chat/completions");
  expect(new Headers(request.init?.headers).get("Authorization")).toBe("Bearer fake-inco-test-key");
  expect(JSON.parse(String(request.init?.body))).toMatchObject({
    model: INCO_DEFAULT_MODEL,
    stream: true,
    reasoning_effort: "low",
    messages: [{ role: "user", content: "hello" }],
  });
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain("fake-inco-test-key");
  expect(serialized).toContain("fak…redacted…key");
  expect(serialized).toContain("reasoning_content");
  expect(records.filter((r) => r.kind === "span-open")).toHaveLength(1);
  expect(records.filter((r) => r.kind === "span-close")).toHaveLength(1);
  await host.deactivate();
});
it("honors host config and env aliases for non-secret overrides", async () => {
  for (const config of [
    {
      "provider.inco.baseURL": "https://custom.test/v1/",
      "provider.inco.model": "custom:fast",
      INCO_MODEL: "ignored",
    },
    { INCO_BASE_URL: "https://custom.test/v1/", INCO_MODEL: "custom:fast" },
  ]) {
    const { provider, host } = await registered(async (url, init) => {
      expect(String(url)).toBe("https://custom.test/v1/chat/completions");
      expect(JSON.parse(String(init?.body)).model).toBe("custom:fast");
      return textResponse();
    }, config);
    await collect(provider.stream(messages, []));
    await host.deactivate();
  }
});
it("fetches authenticated live catalog, preserving fast choices and explicit vision", async () => {
  const { provider, host } = await registered(async (url, init) => {
    expect(String(url)).toBe("https://api.inco.ai/v1/models");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fake-inco-test-key");
    return Response.json({
      data: [
        {
          id: "glm-5.3-flash:fast",
          name: "GLM 5.3 Flash (Fast)",
          context_length: 1048576,
          modalities: { input: ["text", "image", "video"] },
        },
        { id: "glm-5.3", modalities: { input: ["text"] } },
      ],
    });
  });
  expect(await provider.listModels?.()).toEqual([
    {
      id: INCO_DEFAULT_MODEL,
      displayName: "GLM 5.3 Flash (Fast)",
      contextWindow: 1048576,
      vision: true,
    },
    { id: "glm-5.3", vision: false },
  ]);
  await host.deactivate();
});
it("rejects malformed and failed catalog responses with sanitized errors", async () => {
  for (const response of [
    Response.json({ nope: [] }),
    new Response("fake-inco-test-key", { status: 401 }),
  ]) {
    const { provider, host } = await registered(async () => response);
    await expect(provider.listModels?.()).rejects.toThrow(/malformed|HTTP 401/);
    await host.deactivate();
  }
});
it("parses fragmented tool calls and round trips tool-result history through the real library", async () => {
  let count = 0;
  const { provider, host } = await registered(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (count++ === 0) {
      expect(body.tools[0].function.name).toBe("lookup");
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"q":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"value"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
    }
    expect(body.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "found",
    });
    expect(body.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"value"}' },
          },
        ],
      }),
    );
    return textResponse();
  });
  const first = await collect(provider.stream(messages, [tool]));
  expect(first).toContainEqual({
    type: "tool-call",
    toolCallId: "call_1",
    toolName: "lookup",
    input: { q: "value" },
  });
  const second = await collect(
    provider.stream(
      [
        ...messages,
        {
          role: "assistant",
          chunks: [
            { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "value" } },
          ],
        },
        {
          role: "tool",
          chunks: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "lookup",
              content: "found",
              isError: false,
            },
          ],
        },
      ],
      [tool],
    ),
  );
  expect(second).toContainEqual({ type: "text-delta", delta: "hello" });
  expect(count).toBe(2);
  await host.deactivate();
});
it("forwards the authoritative abort signal and emits no retryable failure on abort", async () => {
  const controller = new AbortController();
  const { provider, host } = await registered(async (_url, init) => {
    expect(init?.signal).toBe(controller.signal);
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });
  expect(await collect(provider.stream(messages, [], { signal: controller.signal }))).toEqual([]);
  await host.deactivate();
});
it("omits unsupported reasoning vocabularies and obeys explicit live capability denial", async () => {
  const { provider, host } = await registered(async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({
        data: [{ id: INCO_DEFAULT_MODEL, capabilities: { reasoning_effort: false } }],
      });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("reasoning_effort");
    return textResponse();
  });
  await provider.listModels?.();
  await collect(provider.stream(messages, [], { reasoningEffort: "max" }));
  await collect(
    provider.stream(messages, [], { model: "unknown-maker", reasoningEffort: "xhigh" }),
  );
  await host.deactivate();
});
it("passes verifyPlugin load/unload/reload and real-host keyed provider cleanup", async () => {
  expect(await verifyPlugin(createIncoExtension())).toMatchObject({ ok: true, problems: [] });
  const { host } = await registered(async () => textResponse());
  expect((await host.unloadExtension(manifest.id)).dangling ?? []).toEqual([]);
  expect(host.getProvider("inco")).toBeUndefined();
  expect((await host.loadExtension(createIncoExtension())).ok).toBe(true);
  expect(host.getProvider("inco")).toBeDefined();
  expect((await host.reloadExtension(manifest.id, createIncoExtension())).ok).toBe(true);
  expect((await host.unloadExtension(manifest.id)).dangling ?? []).toEqual([]);
  await host.deactivate();
});
describe("secret mask", () => {
  it.each([
    ["1234567", "…redacted…"],
    ["12345678", "1…redacted…8"],
    ["12345678901", "12…redacted…01"],
    ["1234567890123", "123…redacted…123"],
  ])("masks graduated length %s", (key, masked) => {
    expect(maskIncoSecret(key)).toBe(masked);
  });
});
