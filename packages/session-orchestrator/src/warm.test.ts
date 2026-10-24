import { createConversationStore } from "@dispatch/conversation-store";
import {
  type ChatMessage,
  type ProviderContract,
  type ProviderStreamOptions,
  runTurn,
  type ToolContract,
} from "@dispatch/kernel";
import { createConcurrencyManager } from "@dispatch/provider-concurrency";
import { appendTextFileGuidance, createSystemPromptService } from "@dispatch/system-prompt";
import { describe, expect, it, vi } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createSessionOrchestrator, type SessionOrchestratorDeps } from "./orchestrator.js";
import { createWarmService } from "./warm.js";

const tool = (name: string): ToolContract => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  concurrencySafe: true,
  async execute() {
    return { content: "ok" };
  },
});
const history: readonly ChatMessage[] = [
  {
    role: "user",
    chunks: [{ type: "image", url: "/images/test/screenshot.png", mimeType: "image/png" }],
  },
  { role: "assistant", chunks: [{ type: "text", text: "previous answer" }] },
];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(provider: ProviderContract) {
  const data = new Map<string, string>();
  const store = createConversationStore(storageFromMap(data));
  await store.ensureWorkspace("X");
  await store.setWorkspaceId("test", "X");
  await store.setCwd("test", "/workspace");
  await store.setComputerId("test", "remote");
  await store.setModel("test", "credential/model");
  await store.setReasoningEffort("test", "low");
  await store.setToolPolicy("test", { mode: "allow", names: ["first", "second", "gated"] });
  await store.append("test", history);
  const deps: SessionOrchestratorDeps & { emit: () => void } = {
    conversationStore: store,
    resolveProvider: () => provider,
    resolveModel: () => ({ provider, model: "wire-model" }),
    resolveTools: () => [tool("first"), tool("policy-dropped"), tool("second"), tool("gated")],
    async applyToolsFilter(assembly) {
      return assembly;
    },
    runTurn,
    emit() {},
  };
  return { deps, data, store };
}

describe("shared warm/real request assembly", () => {
  it.each([
    "fresh",
    "missing",
    "cwd",
    "computer",
  ])("matches the next real request with a %s prompt without warm writes", async (state) => {
    const requests: Array<{
      messages: readonly ChatMessage[];
      tools: readonly ToolContract[];
      opts: ProviderStreamOptions | undefined;
    }> = [];
    const provider: ProviderContract = {
      id: "capture",
      async *stream(messages, tools, opts) {
        requests.push({ messages, tools, opts });
        yield { type: "finish", reason: "stop" };
      },
    };
    const { deps, data } = await fixture(provider);
    const promptData = new Map<string, string>();
    const prompt = createSystemPromptService({
      storage: storageFromMap(promptData),
      adapters: {
        fs: {
          async readFile() {
            return "";
          },
        },
        async spawn() {
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        now: () => new Date("2026-10-20T00:00:00Z"),
      },
    });
    await prompt.setTemplate(
      "cwd=[prompt:cwd] workspace=[prompt:workspace_id] model=[prompt:model] id=[prompt:conversation_id]",
    );
    if (state !== "missing") {
      await prompt.construct("test", state === "cwd" ? "/old" : "/workspace", {
        workspaceId: "X",
        model: "credential/model",
        computerId: state === "computer" ? "old" : "remote",
      });
    }
    const cachedPrompt = await prompt.get("test");
    // Fresh metadata must reuse the cached bytes even when the template changes.
    if (state === "fresh") await prompt.setTemplate("not used until stale");
    const filterContexts: unknown[] = [];
    const visionContexts: unknown[] = [];
    const configured = {
      ...deps,
      resolveSystemPrompt: () => prompt,
      async resolveModelUsability(model: string, workspace: string) {
        expect([model, workspace]).toEqual(["credential/model", "X"]);
        return true;
      },
      async applyToolsFilter(assembly: Parameters<SessionOrchestratorDeps["applyToolsFilter"]>[0]) {
        filterContexts.push({
          cwd: assembly.cwd,
          computerId: assembly.computerId,
          modelName: assembly.modelName,
          workspaceId: assembly.workspaceId,
        });
        expect(assembly.signal).toBeInstanceOf(AbortSignal);
        return { ...assembly, tools: [...assembly.tools].reverse() };
      },
      async applyWorkspaceGate(
        assembly: Parameters<SessionOrchestratorDeps["applyToolsFilter"]>[0],
      ) {
        return { ...assembly, tools: assembly.tools.filter((t) => t.name !== "gated") };
      },
      resolveVisionHandoff: () => ({
        async storeImages(_id: string, images: readonly { url: string }[]) {
          return images;
        },
        async purgeConversationImages() {},
        async prepareForProvider(
          messages: readonly ChatMessage[],
          model: string | undefined,
          opts?: { imageLimit?: number; compactionModel?: string | null; signal?: AbortSignal },
        ) {
          expect(opts?.signal).toBeInstanceOf(AbortSignal);
          visionContexts.push({
            model,
            limit: opts?.imageLimit,
            compactionModel: opts?.compactionModel,
          });
          return messages.map((message) => ({
            ...message,
            chunks: message.chunks.map((chunk) =>
              chunk.type === "image" ? { type: "text" as const, text: "prepared image" } : chunk,
            ),
          }));
        },
      }),
      async resolveModelInfo() {
        return { id: "model", name: "model", maxImages: 2 };
      },
    };
    const { orchestrator, activeConversations } = createSessionOrchestrator(configured);
    const before = [...data];
    const promptBefore = [...promptData];
    expect(
      await createWarmService(configured, activeConversations).warm("test"),
    ).not.toHaveProperty("error");
    expect([...data]).toEqual(before);
    expect([...promptData]).toEqual(promptBefore);
    await orchestrator.handleMessage({
      conversationId: "test",
      text: "next question",
      workspaceId: "wrong",
      onEvent() {},
    });
    expect(requests).toHaveLength(2);
    const prefix = (r: (typeof requests)[number] | undefined) => ({
      systemPrompt: r?.opts?.systemPrompt,
      model: r?.opts?.model,
      reasoningEffort: r?.opts?.reasoningEffort,
      tools: r?.tools.map((t) => t.name),
      messages: r?.messages.slice(0, history.length),
    });
    expect(prefix(requests[0])).toEqual(prefix(requests[1]));
    expect(prefix(requests[0])).toMatchObject({
      model: "wire-model",
      reasoningEffort: "low",
      tools: ["second", "first"],
      messages: [{ role: "user", chunks: [{ type: "text", text: "prepared image" }] }, history[1]],
    });
    expect(requests[0]?.opts?.systemPrompt).toBe(
      state === "fresh"
        ? cachedPrompt
        : appendTextFileGuidance("cwd=/workspace workspace=X model=credential/model id=test"),
    );
    expect(await prompt.get("test")).toBe(requests[1]?.opts?.systemPrompt);
    expect(requests[0]?.messages.at(-1)?.chunks).toEqual([
      { type: "text", text: "reply with just a ." },
    ]);
    expect(requests[1]?.messages.at(-1)?.chunks).toEqual([{ type: "text", text: "next question" }]);
    expect(requests[0]?.opts?.maxTokens).toBe(1);
    expect(filterContexts).toEqual(
      Array(2).fill({
        cwd: "/workspace",
        computerId: "remote",
        modelName: "credential/model",
        workspaceId: "X",
      }),
    );
    expect(visionContexts).toHaveLength(2);
    expect(visionContexts[0]).toEqual(visionContexts[1]);
    expect(visionContexts[0]).toMatchObject({ limit: 2 });
  });

  it("warm overrides never set model/cwd/computer or append the probe", async () => {
    const { deps, data } = await fixture({
      id: "p",
      async *stream() {
        yield { type: "finish", reason: "stop" };
      },
    });
    const before = [...data];
    const result = await createWarmService(deps, new Set()).warm("test", {
      modelName: "other/model",
      cwd: "/other",
      computerId: "other",
    });
    expect(result).not.toHaveProperty("error");
    expect([...data]).toEqual(before);
  });
});

describe("warm cancellation and resource release", () => {
  it.each([
    "timeout",
    "abort",
  ])("bounds a hung provider on %s and releases its real concurrency slot", async (kind) => {
    vi.useFakeTimers();
    const limiter = createConcurrencyManager({
      now: Date.now,
      slotTimeoutMs: 300_000,
      watchdogIntervalMs: 300_000,
      defaultPauseMs: 1000,
    });
    limiter.setLimit("hung", 1);
    let returned = 0;
    let signal: AbortSignal | undefined;
    const provider: ProviderContract = {
      id: "hung",
      stream(_messages, _tools, opts) {
        signal = opts?.signal;
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next() {
            return new Promise<IteratorResult<never>>(() => {});
          },
          async return() {
            returned++;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const controller = new AbortController();
    try {
      const { deps } = await fixture(provider);
      const emitted: unknown[] = [];
      const baselineTimers = vi.getTimerCount();
      const warming = createWarmService(
        {
          ...deps,
          resolveConcurrencyLimiter: () => limiter,
          emit: (_hook, payload) => {
            emitted.push(payload);
          },
        },
        new Set(),
      ).warm("test", { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(limiter.getStatus("hung")?.inFlight).toBe(1);
      if (kind === "timeout") {
        await vi.advanceTimersByTimeAsync(59_999);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      } else controller.abort(new Error("cancelled"));
      expect(await warming).toEqual({
        error: kind === "timeout" ? "warm timed out after 60000ms" : "cancelled",
      });
      expect(signal?.aborted).toBe(true);
      expect(limiter.getStatus("hung")?.inFlight).toBe(0);
      expect(returned).toBe(1);
      expect(emitted).toEqual([]);
      expect(limiter.getStatus("hung")?.queued).toBe(0);
      const release = await limiter.acquire("hung", "next", "X", Date.now());
      expect(limiter.getStatus("hung")?.inFlight).toBe(1);
      release();
      expect(limiter.getStatus("hung")?.inFlight).toBe(0);
      expect(vi.getTimerCount()).toBe(baselineTimers);
    } finally {
      limiter.destroy();
      vi.useRealTimers();
    }
  });

  it("removes a timed-out concurrency waiter without starting its provider", async () => {
    vi.useFakeTimers();
    const limiter = createConcurrencyManager({
      now: Date.now,
      slotTimeoutMs: 300_000,
      watchdogIntervalMs: 300_000,
      defaultPauseMs: 1000,
    });
    limiter.setLimit("p", 1);
    const release = await limiter.acquire("p", "busy", "X", Date.now());
    let sends = 0;
    try {
      const { deps } = await fixture({
        id: "p",
        async *stream() {
          sends++;
          yield { type: "finish", reason: "stop" };
        },
      });
      const warming = createWarmService(
        { ...deps, resolveConcurrencyLimiter: () => limiter },
        new Set(),
      ).warm("test");
      await vi.advanceTimersByTimeAsync(0);
      expect(limiter.getStatus("p")?.queued).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await warming).toHaveProperty("error");
      await vi.advanceTimersByTimeAsync(0);
      expect(limiter.getStatus("p")?.queued).toBe(0);
      release();
      expect(limiter.getStatus("p")?.inFlight).toBe(0);
      expect(sends).toBe(0);
    } finally {
      release();
      limiter.destroy();
      vi.useRealTimers();
    }
  });

  it.each([
    "success",
    "throw",
  ])("clears its timeout and finalizes the stream on %s", async (kind) => {
    vi.useFakeTimers();
    let finalized = 0;
    const emitted: unknown[] = [];
    try {
      const { deps } = await fixture({
        id: "p",
        async *stream() {
          try {
            if (kind === "throw") throw new Error("network failed");
            yield { type: "usage", usage: { inputTokens: 4, outputTokens: 1 } };
            yield { type: "finish", reason: "stop" };
          } finally {
            finalized++;
          }
        },
      });
      const result = await createWarmService(
        {
          ...deps,
          emit: (_hook, payload) => {
            emitted.push(payload);
          },
        },
        new Set(),
      ).warm("test");
      expect(result).toEqual(
        kind === "throw"
          ? { error: "network failed" }
          : { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      );
      expect(finalized).toBe(1);
      expect(emitted).toHaveLength(kind === "throw" ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out hung assembly and does not start a provider when it later completes", async () => {
    vi.useFakeTimers();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    try {
      const { deps } = await fixture({
        id: "p",
        async *stream() {
          sends++;
          yield { type: "finish", reason: "stop" };
        },
      });
      const warming = createWarmService(
        {
          ...deps,
          async applyToolsFilter(assembly) {
            await gate;
            return assembly;
          },
        },
        new Set(),
      ).warm("test");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await warming).toHaveProperty("error", "warm timed out after 60000ms");
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(sends).toBe(0);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it("returns streamed provider failures without warmCompleted and clears its timer", async () => {
    const { deps } = await fixture({
      id: "p",
      async *stream() {
        yield { type: "error", message: "upstream failure" };
      },
    });
    const emitted: unknown[] = [];
    expect(
      await createWarmService(
        {
          ...deps,
          emit: (_hook, payload) => {
            emitted.push(payload);
          },
        },
        new Set(),
      ).warm("test"),
    ).toEqual({ error: "upstream failure" });
    await flush();
    expect(emitted).toEqual([]);
  });
});
