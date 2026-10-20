import type { AgentManagementService } from "@dispatch/agent-management";
import type {
  ChatMessage,
  ModelInfo,
  ProviderContract,
  ProviderEvent,
  ToolContract,
} from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import {
  createVisionHandoffService,
  type VisionHandoffDeps,
  type VisionHandoffService,
} from "./service.js";

// ── Test doubles (outermost-edge fakes — NOT @dispatch/* mocks) ──────────────

function makeVisionProvider(
  describe: (imageUrl: string) => string,
  id = "umans",
): ProviderContract {
  return {
    id,
    stream: vi.fn(
      (
        messages: readonly ChatMessage[],
        _tools: readonly ToolContract[],
      ): AsyncIterable<ProviderEvent> => {
        const img = messages.flatMap((m) => m.chunks).find((c) => c.type === "image");
        const url = img && img.type === "image" ? img.url : "";
        const text = describe(url);
        async function* gen(): AsyncIterable<ProviderEvent> {
          yield { type: "text-delta", delta: text };
          yield { type: "finish", reason: "stop" };
        }
        return gen();
      },
    ),
  };
}

function makeDeps(overrides: Partial<VisionHandoffDeps> = {}): VisionHandoffDeps {
  const visionProvider = makeVisionProvider((url) => `DESCRIPTION of ${url}`);
  const catalog = ["umans/umans-kimi-k2.7", "umans/umans-glm-5.2"];
  const infoMap: Record<string, ModelInfo> = {
    "umans/umans-kimi-k2.7": { id: "umans-kimi-k2.7", vision: true },
    "umans/umans-glm-5.2": { id: "umans-glm-5.2" },
  };
  return {
    credentialStore: {
      listCatalog: vi.fn(async () => catalog),
      getModelInfo: vi.fn(async (name: string) => infoMap[name]),
      resolve: vi.fn((name: string) => {
        if (name === "umans/umans-kimi-k2.7")
          return { providerId: "umans", model: "umans-kimi-k2.7" };
        if (name === "umans/umans-glm-5.2") return { providerId: "umans", model: "umans-glm-5.2" };
        return undefined;
      }),
    },
    resolveModel: vi.fn((name: string) =>
      name === "umans/umans-kimi-k2.7" || name === "umans/umans-glm-5.2"
        ? { provider: visionProvider, model: name.split("/")[1] }
        : undefined,
    ),
    readFileAsDataUrl: vi.fn(async (path: string) => `data:image/png;base64,FILE(${path})`),
    setConversationTitle: vi.fn(async (_conversationId: string, _title: string) => {}),
    ...overrides,
  };
}

describe("VisionHandoffService.isVisionCapable", () => {
  it("returns true for kimi (via ModelInfo)", async () => {
    const svc = createVisionHandoffService(makeDeps());
    expect(await svc.isVisionCapable("umans/umans-kimi-k2.7")).toBe(true);
  });

  it("returns false for glm-5.2", async () => {
    const svc = createVisionHandoffService(makeDeps());
    expect(await svc.isVisionCapable("umans/umans-glm-5.2")).toBe(false);
  });

  it("returns false for undefined model name", async () => {
    const svc = createVisionHandoffService(makeDeps());
    expect(await svc.isVisionCapable(undefined)).toBe(false);
  });
});

describe("VisionHandoffService.resolveVisionModel", () => {
  it("resolves the kimi model from the catalog", async () => {
    const svc = createVisionHandoffService(makeDeps());
    const vision = await svc.resolveVisionModel();
    expect(vision?.modelName).toBe("umans/umans-kimi-k2.7");
    expect(vision?.model).toBe("umans-kimi-k2.7");
  });

  it("excludes the given model", async () => {
    const svc = createVisionHandoffService(makeDeps());
    const vision = await svc.resolveVisionModel("umans/umans-kimi-k2.7");
    expect(vision).toBeUndefined();
  });

  it("uses the preferred model when it is vision-capable", async () => {
    // Catalog default would resolve kimi; preferring qwen selects qwen.
    const deps = makeDeps();
    (deps.credentialStore.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValue([
      "umans/umans-glm-5.2",
      "umans/umans-kimi-k2.7",
      "umans/umans-qwen3.6-35b-a3b",
    ]);
    (deps.credentialStore.getModelInfo as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string) => {
        const map: Record<string, ModelInfo> = {
          "umans/umans-kimi-k2.7": { id: "umans-kimi-k2.7", vision: true },
          "umans/umans-qwen3.6-35b-a3b": { id: "umans-qwen3.6-35b-a3b", vision: true },
          "umans/umans-glm-5.2": { id: "umans-glm-5.2" },
        };
        return map[name];
      },
    );
    (deps.credentialStore.resolve as ReturnType<typeof vi.fn>).mockImplementation(
      (name: string) => {
        if (name === "umans/umans-kimi-k2.7")
          return { providerId: "umans", model: "umans-kimi-k2.7" };
        if (name === "umans/umans-qwen3.6-35b-a3b")
          return { providerId: "umans", model: "umans-qwen3.6-35b-a3b" };
        if (name === "umans/umans-glm-5.2") return { providerId: "umans", model: "umans-glm-5.2" };
        return undefined;
      },
    );
    (deps.resolveModel as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === "umans/umans-kimi-k2.7" ||
      name === "umans/umans-qwen3.6-35b-a3b" ||
      name === "umans/umans-glm-5.2"
        ? { provider: makeVisionProvider(() => "x", "umans"), model: name.split("/")[1] }
        : undefined,
    );
    const svc = createVisionHandoffService(deps);
    const vision = await svc.resolveVisionModel(undefined, "umans/umans-qwen3.6-35b-a3b");
    expect(vision?.modelName).toBe("umans/umans-qwen3.6-35b-a3b");
    expect(vision?.model).toBe("umans-qwen3.6-35b-a3b");
  });

  it("falls back to the catalog scan when the preferred model is not vision-capable", async () => {
    const svc = createVisionHandoffService(makeDeps());
    const vision = await svc.resolveVisionModel(undefined, "umans/umans-glm-5.2");
    expect(vision?.modelName).toBe("umans/umans-kimi-k2.7");
  });

  it("falls back to the catalog scan when the preferred model is vision-capable but unresolvable", async () => {
    // Preferred is vision-capable but resolveModel returns undefined for it;
    // must fall back to the catalog scan (kimi).
    const deps = makeDeps();
    (deps.resolveModel as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      // The preferred is NOT resolvable; kimi still is.
      name === "umans/umans-kimi-k2.7"
        ? { provider: makeVisionProvider(() => "x", "umans"), model: "umans-kimi-k2.7" }
        : undefined,
    );
    const svc = createVisionHandoffService(deps);
    const vision = await svc.resolveVisionModel(undefined, "umans/umans-qwen3.6-35b-a3b");
    expect(vision?.modelName).toBe("umans/umans-kimi-k2.7");
  });

  it("returns undefined when the preferred is non-vision and no vision model is in the catalog", async () => {
    const deps = makeDeps();
    (deps.credentialStore.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValue([
      "umans/umans-glm-5.2",
    ]);
    const svc = createVisionHandoffService(deps);
    const vision = await svc.resolveVisionModel(undefined, "umans/umans-glm-5.2");
    expect(vision).toBeUndefined();
  });
});

describe("VisionHandoffService.prepareForProvider", () => {
  it("passes messages through unchanged when the model is vision-capable", async () => {
    const deps = makeDeps();
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [
      {
        role: "user",
        chunks: [
          { type: "text", text: "What's this?" },
          { type: "image", url: "data:image/png;base64,abc" },
        ],
      },
    ];
    const result = await svc.prepareForProvider(messages, "umans/umans-kimi-k2.7");
    expect(result).toBe(messages); // same reference — no copy, no change
  });

  it("passes messages through unchanged when there are no images", async () => {
    const deps = makeDeps();
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [{ role: "user", chunks: [{ type: "text", text: "hi" }] }];
    const result = await svc.prepareForProvider(messages, "umans/umans-glm-5.2");
    expect(result).toBe(messages);
  });

  it("replaces image chunks with numbered placeholders for a non-vision model", async () => {
    const deps = makeDeps();
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [
      {
        role: "user",
        chunks: [
          { type: "text", text: "Describe this" },
          { type: "image", url: "data:image/png;base64,img1" },
        ],
      },
    ];
    const result = await svc.prepareForProvider(messages, "umans/umans-glm-5.2", {
      conversationId: "conv-1",
    });
    expect(result).toHaveLength(1);
    const chunks = result[0]?.chunks;
    expect(chunks).toHaveLength(2);
    // Text chunk unchanged.
    expect(chunks?.[0]).toEqual({ type: "text", text: "Describe this" });
    // Image chunk → placeholder text.
    expect(chunks?.[1]?.type).toBe("text");
    const placeholder = (chunks?.[1] as { text: string }).text;
    expect(placeholder).toContain("Image 1");
    expect(placeholder).toContain("consult_vision");
  });

  it("assigns sequential image IDs across multiple messages", async () => {
    const deps = makeDeps();
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "image", url: "data:image/png;base64,a" }] },
      { role: "assistant", chunks: [{ type: "text", text: "ok" }] },
      { role: "user", chunks: [{ type: "image", url: "data:image/png;base64,b" }] },
    ];
    const result = await svc.prepareForProvider(messages, "umans/umans-glm-5.2", {
      conversationId: "conv-1",
    });
    // First image → Image 1, second → Image 2.
    expect((result[0]?.chunks[0] as { text: string }).text).toContain("Image 1");
    // Assistant message unchanged.
    expect(result[1]?.chunks[0]?.type).toBe("text");
    expect((result[2]?.chunks[0] as { text: string }).text).toContain("Image 2");
  });

  it("registers images so getRegisteredImage can look them up", async () => {
    const deps = makeDeps();
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [
      {
        role: "user",
        chunks: [{ type: "image", url: "data:image/png;base64,registered" }],
      },
    ];
    await svc.prepareForProvider(messages, "umans/umans-glm-5.2", { conversationId: "conv-42" });
    const img = svc.getRegisteredImage("conv-42", 1);
    expect(img?.url).toBe("data:image/png;base64,registered");
  });

  it("uses no-vision placeholder when no vision model is available", async () => {
    const deps = makeDeps();
    (deps.credentialStore.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "image", url: "data:image/png;base64,abc" }] },
    ];
    const result = await svc.prepareForProvider(messages, "umans/umans-glm-5.2", {
      conversationId: "conv-1",
    });
    const text = (result[0]?.chunks[0] as { text: string }).text;
    expect(text).toContain("no vision-capable model");
    expect(text).not.toContain("consult_vision");
  });

  it("uses the configured compactionModel to transcribe compacted images", async () => {
    // Vision-capable current model with imageLimit=1 and two images: the oldest
    // is compacted to text. With a preferred compactionModel set, the
    // transcription must use THAT model (not the default catalog scan).
    const kimiProvider = makeVisionProvider((url) => `KIMI(${url})`, "umans");
    const qwenProvider = makeVisionProvider((url) => `QWEN(${url})`, "umans-qwen");
    const deps = makeDeps();
    (deps.credentialStore.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValue([
      "umans/umans-kimi-k2.7", // default scan would pick this
      "umans/umans-qwen3.6-35b-a3b",
    ]);
    (deps.credentialStore.getModelInfo as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string) => {
        const map: Record<string, ModelInfo> = {
          "umans/umans-kimi-k2.7": { id: "umans-kimi-k2.7", vision: true },
          "umans/umans-qwen3.6-35b-a3b": { id: "umans-qwen3.6-35b-a3b", vision: true },
        };
        return map[name];
      },
    );
    (deps.credentialStore.resolve as ReturnType<typeof vi.fn>).mockImplementation(
      (name: string) => {
        if (name === "umans/umans-kimi-k2.7")
          return { providerId: "umans", model: "umans-kimi-k2.7" };
        if (name === "umans/umans-qwen3.6-35b-a3b")
          return { providerId: "umans-qwen", model: "umans-qwen3.6-35b-a3b" };
        return undefined;
      },
    );
    (deps.resolveModel as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === "umans/umans-kimi-k2.7")
        return { provider: kimiProvider, model: "umans-kimi-k2.7" };
      if (name === "umans/umans-qwen3.6-35b-a3b")
        return { provider: qwenProvider, model: "umans-qwen3.6-35b-a3b" };
      return undefined;
    });
    const svc = createVisionHandoffService(deps);

    const messages: ChatMessage[] = [
      {
        role: "user",
        chunks: [
          { type: "text", text: "look" },
          { type: "image", url: "data:image/png;base64,OLD" },
          { type: "image", url: "data:image/png;base64,NEW" },
        ],
      },
    ];
    const result = await svc.prepareForProvider(messages, "umans/umans-kimi-k2.7", {
      conversationId: "conv-1",
      imageLimit: 1,
      compactionModel: "umans/umans-qwen3.6-35b-a3b",
    });
    // The oldest image (OLD) is compacted to text via the PREFERRED qwen model.
    const transcribed = result[0]?.chunks.find(
      (c) => c.type === "text" && c.text.includes("Compacted image"),
    ) as { text: string } | undefined;
    expect(transcribed).toBeDefined();
    expect(transcribed?.text).toContain("QWEN(data:image/png;base64,OLD)");
    // The most recent image (NEW) stays native.
    expect(result[0]?.chunks.some((c) => c.type === "image")).toBe(true);
    // kimi was NOT used for transcription (preferred overrode the catalog scan).
    expect(kimiProvider.stream).not.toHaveBeenCalled();
  });

  it("an abort during a never-yielding vision stream stops promptly (no failure placeholder cached)", async () => {
    // A vision provider whose stream yields nothing then hangs — so an abort
    // cannot be satisfied by consuming events; the abort barrier must win.
    const hangingVision: ProviderContract = {
      id: "vision-hang",
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<ProviderEvent>>(() => {}), // never settles
              return: () => Promise.resolve({ done: true, value: undefined }),
            };
          },
        };
      },
    };
    // force compactionModel so resolveVisionModel returns the hanging provider.
    const deps = makeDeps({
      resolveModel: vi.fn(() => ({ provider: hangingVision, model: "vision-hang" })),
    });
    const svc = createVisionHandoffService(deps);

    const ac = new AbortController();
    // Two images, limit 1 → exactly one needs transcription.
    const messages: ChatMessage[] = [
      {
        role: "user",
        chunks: [
          { type: "text", text: "x" },
          { type: "image", url: "data:image/png;base64,img1" },
          { type: "image", url: "data:image/png;base64,img2" },
        ],
      },
    ];

    // The abort barrier wins over the hanging vision stream. prepareForProvider
    // treats the deliberate abort as cancellation: it stops, does NOT cache a
    // failure placeholder, and returns normally (the orchestrator's runTurn
    // then seals the turn as aborted via its first-step signal check).
    const resultPromise = svc.prepareForProvider(messages, "umans/umans-glm-5.2", {
      conversationId: "conv-abort-vision",
      imageLimit: 1,
      compactionModel: "forced/vision-hang",
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 10);

    // Settles promptly (bounded by the abort race, not the hanging stream).
    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 500)),
    ]);
    // No failed-transcription placeholder was cached for the deliberate abort.
    const flatText = result
      .flatMap((m) => m.chunks)
      .filter(
        (c): c is Extract<ChatMessage["chunks"][number], { type: "text" }> => c.type === "text",
      )
      .map((c) => c.text)
      .join(" ");
    expect(flatText).not.toContain("failed");
    expect(flatText).not.toContain("no vision model available");
    void ac;
  });

  it("stops before starting the next image's transcription once the signal aborts (multi-image)", async () => {
    let visionStreamCalls = 0;
    const deps = makeDeps({
      resolveModel: vi.fn(() => ({
        provider: {
          id: "vision-count",
          stream() {
            visionStreamCalls++;
            return (async function* () {
              yield { type: "text-delta", delta: "described" } as ProviderEvent;
              yield { type: "finish", reason: "stop" } as ProviderEvent;
            })();
          },
        } as ProviderContract,
        model: "vision-count",
      })),
    });
    const svc = createVisionHandoffService(deps);

    const ac = new AbortController();
    // 3 images, limit 1 → 2 need transcription. First succeeds; before the
    // second, abort fires and the loop stops.
    const messages: ChatMessage[] = [
      {
        role: "user",
        chunks: [
          { type: "image", url: "data:image/png;base64,a" },
          { type: "image", url: "data:image/png;base64,b" },
          { type: "image", url: "data:image/png;base64,c" },
        ],
      },
    ];

    const resultPromise = svc.prepareForProvider(messages, "umans/umans-glm-5.2", {
      conversationId: "conv-multi-img",
      imageLimit: 1,
      compactionModel: "forced/vision-count",
      signal: ac.signal,
    });
    // Abort right after the first transcription stream call resolves.
    await new Promise((resolve) => setTimeout(resolve, 5));
    ac.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Because the abort fired, the loop stops before the second transcription.
    // prepareForProvider may reject with AbortError (it propagates) — either
    // way the vision provider was called at most once for transcription.
    await resultPromise.catch(() => {});
    expect(visionStreamCalls).toBeLessThanOrEqual(1);
  });
});

describe("VisionHandoffService.consultVision", () => {
  /**
   * A fake AgentManagementService — only `summon` is exercised by consultVision;
   * the other methods are stubs. `summon` records its input (so tests assert
   * the hard-isolation guarantees: toolAccess none, systemPrompt, wait, title,
   * inherited callerConversationId) and returns the configured reply.
   */
  function makeAgentManagementDouble(
    reply = "The error is on line 12.",
    summonImpl?: (input: Record<string, unknown>) => Promise<unknown>,
  ): {
    service: AgentManagementService;
    summon: ReturnType<typeof vi.fn>;
  } {
    const summon = vi.fn(
      summonImpl ??
        (async (_input: Record<string, unknown>) => ({
          ok: true as const,
          value: {
            conversationId: "consultation-xyz",
            workspaceId: "ws-1",
            status: "idle" as const,
            started: true,
            reply,
          },
        })),
    );
    const svc = {
      summon,
      listModels: vi.fn(async () => ({ ok: true, value: { models: [] } })),
      list: vi.fn(async () => ({ ok: true, value: { agents: [], truncated: false } })),
      read: vi.fn(async () => ({ ok: true, value: { reply: "", truncated: false } })),
      send: vi.fn(async () => ({ ok: true, value: { delivered: "started-turn" } })),
      cancelMessage: vi.fn(async () => ({ ok: true, value: { cancelled: true, queueLength: 0 } })),
      open: vi.fn(async () => ({ ok: true, value: { workspaceId: "ws-1" } })),
    } as unknown as AgentManagementService;
    return { service: svc, summon };
  }

  /** Register a pasted image (as prepareForProvider would) and return its id. */
  async function registerImage(
    svc: VisionHandoffService,
    conversationId: string,
    url: string,
  ): Promise<void> {
    const messages: ChatMessage[] = [{ role: "user", chunks: [{ type: "image", url }] }];
    await svc.prepareForProvider(messages, "umans/umans-glm-5.2", { conversationId });
  }

  it("opens a new consultation with a pasted image and returns convId + response", async () => {
    const deps = makeDeps();
    const { service: agentMgmt, summon } = makeAgentManagementDouble("The error is on line 12.");
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    await registerImage(svc, "conv-1", "data:image/png;base64,img1");

    const result = await svc.consultVision("What error is shown?", {
      conversationId: "conv-1",
      imageIds: [1],
    });

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.conversationId).toBe("consultation-xyz");
      expect(result.response).toContain("line 12");
      expect(result.response).toContain(result.conversationId);
      // Follow-up now points to management tools, not the CLI only.
      expect(result.response).toContain("send_agent_message");
    }
    // summon was called with the vision model + the image + hard isolation.
    expect(summon).toHaveBeenCalledOnce();
    const call = summon.mock.calls[0]?.[0];
    expect(call.model).toBe("umans/umans-kimi-k2.7");
    expect(call.images).toHaveLength(1);
    expect(call.images?.[0]?.url).toBe("data:image/png;base64,img1");
  });

  it("passes toolAccess none, wait, open, systemPrompt, and title (hard isolation)", async () => {
    const deps = makeDeps();
    const { service: agentMgmt, summon } = makeAgentManagementDouble();
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    await registerImage(svc, "conv-1", "data:image/png;base64,img1");

    await svc.consultVision("What error is shown?", {
      conversationId: "conv-1",
      imageIds: [1],
    });

    const call = summon.mock.calls[0]?.[0];
    // toolAccess none → durable toolPolicy { mode: "none" } (provider sees []).
    expect(call.toolAccess).toBe("none");
    expect(call.wait).toBe(true);
    expect(call.open).toBe(true);
    expect(call.systemPrompt).toEqual(expect.any(String));
    expect(call.systemPrompt.length).toBeGreaterThan(0);
    // Title carries the IMAGE - prefix.
    expect(call.title).toBe("IMAGE - What error is shown?");
  });

  it("inherits the caller's conversation id (lineage)", async () => {
    const deps = makeDeps();
    const { service: agentMgmt, summon } = makeAgentManagementDouble();
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    await registerImage(svc, "parent-conv", "data:image/png;base64,img1");

    await svc.consultVision("What?", { conversationId: "parent-conv", imageIds: [1] });

    // The service resolves workspace/cwd/computer from this caller id (plan §11
    // guarantee 5) — vision-handoff passes it through as callerConversationId.
    expect(summon.mock.calls[0]?.[0].callerConversationId).toBe("parent-conv");
    // No explicit cwd/computerId override is forced by vision-handoff when the
    // caller didn't pass one — inheritance is the service's job.
    expect(summon.mock.calls[0]?.[0].cwd).toBeUndefined();
  });

  it("forwards an explicit cwd override", async () => {
    const deps = makeDeps();
    const { service: agentMgmt, summon } = makeAgentManagementDouble();
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    await registerImage(svc, "conv-1", "data:image/png;base64,img1");

    await svc.consultVision("What?", { conversationId: "conv-1", imageIds: [1], cwd: "/work" });

    expect(summon.mock.calls[0]?.[0].cwd).toBe("/work");
  });

  it("parent receives text only (the reply), not tool data or child reasoning", async () => {
    const deps = makeDeps();
    const { service: agentMgmt } = makeAgentManagementDouble("ANSWER TEXT");
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    await registerImage(svc, "conv-1", "data:image/png;base64,img1");

    const result = await svc.consultVision("What?", { conversationId: "conv-1", imageIds: [1] });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      // The response is the vision model's answer text, wrapped by
      // formatConsultResult — no tool calls or reasoning leaked through.
      expect(result.response).toContain("ANSWER TEXT");
    }
  });

  it("opens a consultation with a file path image", async () => {
    const deps = makeDeps();
    const { service: agentMgmt } = makeAgentManagementDouble("It's a diagram.");
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    const result = await svc.consultVision("What is this diagram?", {
      conversationId: "conv-1",
      path: "diagram.png",
      cwd: "/work",
    });

    expect("error" in result).toBe(false);
    expect(deps.readFileAsDataUrl).toHaveBeenCalledWith("diagram.png", "/work");
  });

  it("returns an error when imageId is not registered", async () => {
    const deps = makeDeps();
    const { service: agentMgmt } = makeAgentManagementDouble();
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    const result = await svc.consultVision("What?", {
      conversationId: "conv-1",
      imageIds: [99], // not registered
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Image 99");
    }
  });

  it("returns an error when no agent-management service is available", async () => {
    const deps = makeDeps();
    // No resolveAgentManagement provided.
    const svc = createVisionHandoffService(deps);
    const result = await svc.consultVision("What?", {
      conversationId: "conv-1",
      imageIds: [1],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Agent management");
    }
  });

  it("returns an error when no vision model is available", async () => {
    const deps = makeDeps();
    (deps.credentialStore.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { service: agentMgmt } = makeAgentManagementDouble();
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);
    const result = await svc.consultVision("What?", {
      conversationId: "conv-1",
      imageIds: [1],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("No vision-capable model");
    }
  });

  it("returns an error when no image source is provided", async () => {
    const deps = makeDeps();
    const { service: agentMgmt } = makeAgentManagementDouble();
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);
    const result = await svc.consultVision("What?", {
      conversationId: "conv-1",
    });
    expect("error" in result).toBe(true);
  });

  it("surfaces a typed error when summon itself fails", async () => {
    const deps = makeDeps();
    const { service: agentMgmt } = makeAgentManagementDouble("", async () => ({
      ok: false,
      error: { code: "unknown-model", message: "model vanished" },
    }));
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    await registerImage(svc, "conv-1", "data:image/png;base64,img1");

    const result = await svc.consultVision("What?", { conversationId: "conv-1", imageIds: [1] });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("model vanished");
    }
  });

  it("returns an error when the wait times out (child still running)", async () => {
    const deps = makeDeps();
    const { service: agentMgmt } = makeAgentManagementDouble("", async () => ({
      ok: true,
      value: {
        conversationId: "c-running",
        workspaceId: "ws",
        status: "active",
        started: true,
        waitTimeout: true,
      },
    }));
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    await registerImage(svc, "conv-1", "data:image/png;base64,img1");

    const result = await svc.consultVision("What?", { conversationId: "conv-1", imageIds: [1] });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("timed out");
      expect(result.error).toContain("c-running");
    }
  });

  it("uses the configured compaction model (via getVisionSettings) for the consultation", async () => {
    // Two vision models in the catalog; default scan would pick kimi first.
    // The configured compactionModel points at qwen — consultVision must use it.
    const deps = makeDeps();
    (deps.credentialStore.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValue([
      "umans/umans-glm-5.2",
      "umans/umans-kimi-k2.7",
      "umans/umans-qwen3.6-35b-a3b",
    ]);
    (deps.credentialStore.getModelInfo as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string) => {
        const map: Record<string, ModelInfo> = {
          "umans/umans-kimi-k2.7": { id: "umans-kimi-k2.7", vision: true },
          "umans/umans-qwen3.6-35b-a3b": { id: "umans-qwen3.6-35b-a3b", vision: true },
          "umans/umans-glm-5.2": { id: "umans-glm-5.2" },
        };
        return map[name];
      },
    );
    (deps.credentialStore.resolve as ReturnType<typeof vi.fn>).mockImplementation(
      (name: string) => {
        if (name === "umans/umans-kimi-k2.7")
          return { providerId: "umans", model: "umans-kimi-k2.7" };
        if (name === "umans/umans-qwen3.6-35b-a3b")
          return { providerId: "umans", model: "umans-qwen3.6-35b-a3b" };
        if (name === "umans/umans-glm-5.2") return { providerId: "umans", model: "umans-glm-5.2" };
        return undefined;
      },
    );
    (deps.resolveModel as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === "umans/umans-kimi-k2.7" ||
      name === "umans/umans-qwen3.6-35b-a3b" ||
      name === "umans/umans-glm-5.2"
        ? { provider: makeVisionProvider(() => "desc", "umans"), model: name.split("/")[1] }
        : undefined,
    );
    deps.getVisionSettings = async () => ({
      imageLimit: 10,
      compactionModel: "umans/umans-qwen3.6-35b-a3b",
    });
    const { service: agentMgmt, summon } = makeAgentManagementDouble("saw a chart");
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    const result = await svc.consultVision("What is this diagram?", {
      conversationId: "conv-1",
      path: "diagram.png",
    });
    expect("error" in result).toBe(false);
    expect(summon).toHaveBeenCalledOnce();
    expect(summon.mock.calls[0]?.[0].model).toBe("umans/umans-qwen3.6-35b-a3b");
  });

  it("falls back to auto-select when compactionModel is null (via getVisionSettings)", async () => {
    const deps = makeDeps();
    deps.getVisionSettings = async () => ({ imageLimit: 10, compactionModel: null });
    const { service: agentMgmt, summon } = makeAgentManagementDouble();
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    await svc.consultVision("What?", {
      conversationId: "conv-1",
      path: "diagram.png",
    });
    // Auto-select picks the first vision model in the catalog (kimi).
    expect(summon.mock.calls[0]?.[0].model).toBe("umans/umans-kimi-k2.7");
  });

  it("falls back to auto-select when getVisionSettings is not provided", async () => {
    const deps = makeDeps();
    // getVisionSettings deliberately NOT provided (legacy wiring).
    const { service: agentMgmt, summon } = makeAgentManagementDouble();
    deps.resolveAgentManagement = () => agentMgmt;
    const svc = createVisionHandoffService(deps);

    await svc.consultVision("What?", {
      conversationId: "conv-1",
      path: "diagram.png",
    });
    expect(summon.mock.calls[0]?.[0].model).toBe("umans/umans-kimi-k2.7");
  });
});

// ── Lazy image resolution + per-image transcription cache ───────────────────

/**
 * Deps wired with a fake per-image cache, a fake compact-URL resolver, and a
 * fake tmp-file deleter. All are outermost-edge fakes (vitest fns), never
 * mocks of our own modules.
 */
function makeImageDeps(
  cached: Readonly<Record<string, string>> = {},
  overrides: Partial<VisionHandoffDeps> = {},
): {
  deps: VisionHandoffDeps;
  cache: Map<string, string>;
  getImageTranscriptions: ReturnType<typeof vi.fn>;
  setImageTranscription: ReturnType<typeof vi.fn>;
  resolveImageUrl: ReturnType<typeof vi.fn>;
  deleteTmpImage: ReturnType<typeof vi.fn>;
} {
  const cache = new Map<string, string>(Object.entries(cached));
  const getImageTranscriptions = vi.fn(async (_conversationId: string, urls: readonly string[]) => {
    const out = new Map<string, string>();
    for (const url of urls) {
      const text = cache.get(url);
      if (text !== undefined) out.set(url, text);
    }
    return out;
  });
  const setImageTranscription = vi.fn(
    async (_conversationId: string, url: string, text: string) => {
      cache.set(url, text);
    },
  );
  const resolveImageUrl = vi.fn(async (url: string) => `data:image/png;base64,RESOLVED(${url})`);
  const deleteTmpImage = vi.fn(async (_url: string) => {});
  const deps = makeDeps({
    getImageTranscriptions,
    setImageTranscription,
    resolveImageUrl,
    deleteTmpImage,
    ...overrides,
  });
  return {
    deps,
    cache,
    getImageTranscriptions,
    setImageTranscription,
    resolveImageUrl,
    deleteTmpImage,
  };
}

/** A message list with one user message carrying `urls` as image chunks. */
function imagesMessage(urls: readonly string[]): ChatMessage[] {
  return [
    {
      role: "user",
      chunks: [
        { type: "text", text: "look at these" },
        ...urls.map((url) => ({ type: "image" as const, url })),
      ],
    },
  ];
}

/** The flat text of a provider message list (for placeholder assertions). */
function flatText(messages: readonly ChatMessage[]): string {
  return messages
    .flatMap((m) => m.chunks)
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("VisionHandoffService lazy image resolution", () => {
  it("resolves only native images + cache misses (never cached transcribed images)", async () => {
    const urls = [1, 2, 3, 4, 5].map((n) => `/images/conv-a/img${n}.png`);
    const { deps, resolveImageUrl, getImageTranscriptions, setImageTranscription } = makeImageDeps({
      [urls[0] as string]: "cached one",
      [urls[1] as string]: "cached two",
    });
    const svc = createVisionHandoffService(deps);

    const result = await svc.prepareForProvider(imagesMessage(urls), "umans/umans-kimi-k2.7", {
      conversationId: "conv-a",
      imageLimit: 2,
    });

    // Cache lookup asked ONLY for the images that need transcription.
    expect(getImageTranscriptions).toHaveBeenCalledOnce();
    expect(getImageTranscriptions.mock.calls[0]?.[1]).toEqual(urls.slice(0, 3));

    // The resolver ran for the cache miss (img3) + the two native images
    // (img4, img5) — never for the cached images img1/img2.
    const resolvedUrls = resolveImageUrl.mock.calls.map((c) => c[0] as string);
    expect(resolvedUrls.sort()).toEqual([urls[2], urls[3], urls[4]].sort());
    expect(resolvedUrls).not.toContain(urls[0]);
    expect(resolvedUrls).not.toContain(urls[1]);

    // img3 was transcribed and cached under its PERSISTED url.
    expect(setImageTranscription).toHaveBeenCalledOnce();
    expect(setImageTranscription.mock.calls[0]?.[1]).toBe(urls[2]);

    // Provider view: cached text, fresh text, then the two native images.
    const chunks = result[0]?.chunks ?? [];
    expect(flatText(result)).toContain("[Compacted image]: cached one");
    expect(flatText(result)).toContain("[Compacted image]: cached two");
    const native = chunks.filter((c) => c.type === "image");
    expect(native.map((c) => (c as { url: string }).url)).toEqual([
      `data:image/png;base64,RESOLVED(${urls[3]})`,
      `data:image/png;base64,RESOLVED(${urls[4]})`,
    ]);
  });

  it("caches a miss under the persisted URL and deletes the tmp file by compact URL", async () => {
    const url = "/images/conv-b/img1.png";
    const native = "/images/conv-b/img2.png";
    const { deps, setImageTranscription, deleteTmpImage, resolveImageUrl } = makeImageDeps();
    const svc = createVisionHandoffService(deps);

    await svc.prepareForProvider(imagesMessage([url, native]), "umans/umans-kimi-k2.7", {
      conversationId: "conv-b",
      imageLimit: 1,
    });

    // The vision model was sent the RESOLVED data URL...
    expect(resolveImageUrl).toHaveBeenCalledWith(url);
    // ...but the cache write + deletion use the PERSISTED compact URL.
    expect(setImageTranscription).toHaveBeenCalledWith(
      "conv-b",
      url,
      expect.stringContaining(`DESCRIPTION of data:image/png;base64,RESOLVED(${url})`),
    );
    expect(deleteTmpImage).toHaveBeenCalledWith(url);
    // The native image's file is NOT deleted.
    expect(deleteTmpImage).not.toHaveBeenCalledWith(native);
  });

  it("second turn: no transcription and no reads of already-transcribed images", async () => {
    const transcribed = "/images/conv-c/img1.png";
    const native = "/images/conv-c/img2.png";
    const { deps, resolveImageUrl, setImageTranscription } = makeImageDeps();
    const svc = createVisionHandoffService(deps);
    const opts = { conversationId: "conv-c", imageLimit: 1 };

    await svc.prepareForProvider(
      imagesMessage([transcribed, native]),
      "umans/umans-kimi-k2.7",
      opts,
    );
    expect(setImageTranscription).toHaveBeenCalledOnce();

    resolveImageUrl.mockClear();
    const visionProvider = deps.resolveModel("umans/umans-kimi-k2.7")?.provider;
    const firstStreamCalls = (visionProvider?.stream as ReturnType<typeof vi.fn>).mock.calls.length;

    const second = await svc.prepareForProvider(
      imagesMessage([transcribed, native]),
      "umans/umans-kimi-k2.7",
      opts,
    );

    // Zero transcription calls; the cached image is never resolved again.
    expect((visionProvider?.stream as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      firstStreamCalls,
    );
    expect(resolveImageUrl).toHaveBeenCalledTimes(1);
    expect(resolveImageUrl).toHaveBeenCalledWith(native);
    expect(flatText(second)).toContain("[Compacted image]: DESCRIPTION of");
  });

  it("a missing native image falls back to the unavailable placeholder (turn proceeds)", async () => {
    const missing = "/images/conv-d/gone.png";
    const present = "/images/conv-d/here.png";
    const { deps } = makeImageDeps();
    const resolve = deps.resolveImageUrl as ReturnType<typeof vi.fn>;
    resolve.mockImplementation(async (url: string) => {
      if (url === missing)
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      return `data:image/png;base64,RESOLVED(${url})`;
    });
    const svc = createVisionHandoffService(deps);

    const result = await svc.prepareForProvider(
      imagesMessage([missing, present]),
      "umans/umans-kimi-k2.7",
      {
        conversationId: "conv-d",
        imageLimit: 5,
      },
    );

    expect(flatText(result)).toContain(
      "[Image unavailable — the original file is no longer on disk.]",
    );
    // The readable image still travels natively.
    expect(
      result[0]?.chunks.some((c) => c.type === "image" && c.url.includes(`RESOLVED(${present})`)),
    ).toBe(true);
  });

  it("a missing native image uses its cached transcription when one exists", async () => {
    // The "imageLimit was raised after transcribed images were deleted" case.
    const gone = "/images/conv-e/gone.png";
    const { deps, getImageTranscriptions } = makeImageDeps({ [gone]: "a cached description" });
    (deps.resolveImageUrl as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const svc = createVisionHandoffService(deps);

    const result = await svc.prepareForProvider(imagesMessage([gone]), "umans/umans-kimi-k2.7", {
      conversationId: "conv-e",
      imageLimit: 5,
    });

    expect(flatText(result)).toContain("[Compacted image]: a cached description");
    expect(getImageTranscriptions).toHaveBeenCalledWith("conv-e", [gone]);
  });

  it("a missing image that needs transcription is not cached (retryable, turn proceeds)", async () => {
    const gone = "/images/conv-f/gone.png";
    const native = "/images/conv-f/here.png";
    const { deps, setImageTranscription, deleteTmpImage } = makeImageDeps();
    (deps.resolveImageUrl as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url === gone) throw new Error("ENOENT");
      return `data:image/png;base64,RESOLVED(${url})`;
    });
    const svc = createVisionHandoffService(deps);

    const result = await svc.prepareForProvider(
      imagesMessage([gone, native]),
      "umans/umans-kimi-k2.7",
      {
        conversationId: "conv-f",
        imageLimit: 1,
      },
    );

    expect(flatText(result)).toContain(
      "[Image unavailable — the original file is no longer on disk.]",
    );
    // No cache write and no delete for a failed resolve — it can be retried.
    expect(setImageTranscription).not.toHaveBeenCalled();
    expect(deleteTmpImage).not.toHaveBeenCalled();
  });

  it("abort mid-transcription writes no cache entry and deletes no file", async () => {
    const hangingVision: ProviderContract = {
      id: "vision-hang",
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<ProviderEvent>>(() => {}), // never settles
              return: () => Promise.resolve({ done: true, value: undefined }),
            };
          },
        };
      },
    };
    const urls = ["/images/conv-g/a.png", "/images/conv-g/b.png"];
    const { deps, setImageTranscription, deleteTmpImage, resolveImageUrl } = makeImageDeps(
      {},
      { resolveModel: vi.fn(() => ({ provider: hangingVision, model: "vision-hang" })) },
    );
    const svc = createVisionHandoffService(deps);
    const ac = new AbortController();

    const promise = svc.prepareForProvider(imagesMessage(urls), "umans/umans-kimi-k2.7", {
      conversationId: "conv-g",
      imageLimit: 1,
      compactionModel: "forced/vision-hang",
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 10);

    await Promise.race([
      promise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 500)),
    ]);

    expect(resolveImageUrl).toHaveBeenCalledWith(urls[0]);
    expect(setImageTranscription).not.toHaveBeenCalled();
    expect(deleteTmpImage).not.toHaveBeenCalled();
  });

  it("compaction disabled (limit 0) resolves all images natively", async () => {
    const urls = ["/images/conv-h/a.png", "/images/conv-h/b.png"];
    const { deps, resolveImageUrl } = makeImageDeps();
    const svc = createVisionHandoffService(deps);

    const result = await svc.prepareForProvider(imagesMessage(urls), "umans/umans-kimi-k2.7", {
      conversationId: "conv-h",
      imageLimit: 0,
    });

    expect(resolveImageUrl.mock.calls.map((c) => c[0])).toEqual(urls);
    const images = result[0]?.chunks.filter((c) => c.type === "image") ?? [];
    expect(images).toHaveLength(2);
  });
});

describe("VisionHandoffService non-vision branch (lazy registry)", () => {
  it("does not resolve during prepareForProvider and stores persisted URLs", async () => {
    const url = "/images/conv-i/img1.png";
    const { deps, resolveImageUrl } = makeImageDeps();
    const svc = createVisionHandoffService(deps);

    await svc.prepareForProvider(imagesMessage([url]), "umans/umans-glm-5.2", {
      conversationId: "conv-i",
    });

    expect(resolveImageUrl).not.toHaveBeenCalled();
    expect(svc.getRegisteredImage("conv-i", 1)?.url).toBe(url);
  });

  it("consultVision resolves the registered persisted URL on use", async () => {
    const url = "/images/conv-j/img1.png";
    const { deps, resolveImageUrl } = makeImageDeps();
    const summon = vi.fn(async (_input: Record<string, unknown>) => ({
      ok: true as const,
      value: {
        conversationId: "consultation-j",
        workspaceId: "ws-1",
        status: "idle" as const,
        started: true,
        reply: "saw it",
      },
    }));
    deps.resolveAgentManagement = () => ({ summon }) as unknown as AgentManagementService;
    const svc = createVisionHandoffService(deps);

    await svc.prepareForProvider(imagesMessage([url]), "umans/umans-glm-5.2", {
      conversationId: "conv-j",
    });
    expect(resolveImageUrl).not.toHaveBeenCalled();

    const result = await svc.consultVision("What is it?", {
      conversationId: "conv-j",
      imageIds: [1],
    });

    expect("error" in result).toBe(false);
    expect(resolveImageUrl).toHaveBeenCalledWith(url);
    const call = summon.mock.calls[0]?.[0];
    expect(call.images).toEqual([{ url: `data:image/png;base64,RESOLVED(${url})` }]);
  });

  it("consultVision reports a typed error when the image file is gone", async () => {
    const url = "/images/conv-k/gone.png";
    const { deps } = makeImageDeps();
    (deps.resolveImageUrl as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    deps.resolveAgentManagement = () => ({ summon: vi.fn() }) as unknown as AgentManagementService;
    const svc = createVisionHandoffService(deps);

    await svc.prepareForProvider(imagesMessage([url]), "umans/umans-glm-5.2", {
      conversationId: "conv-k",
    });

    const result = await svc.consultVision("What?", { conversationId: "conv-k", imageIds: [1] });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("no longer available");
  });
});

it("text-only preparation retains a cached description after image expiry without reading bytes", async () => {
  const url = "/images/expired/gone.png";
  const { deps, cache, resolveImageUrl, deleteTmpImage } = makeImageDeps({
    [url]: "surviving description",
  });
  resolveImageUrl.mockRejectedValue(new Error("ENOENT"));
  const svc = createVisionHandoffService(deps);
  const result = await svc.prepareForProvider(imagesMessage([url]), "umans/umans-glm-5.2", {
    conversationId: "expired",
  });
  expect(flatText(result)).toContain("[Compacted image]: surviving description");
  expect(cache.get(url)).toBe("surviving description");
  expect(resolveImageUrl).not.toHaveBeenCalled();
  expect(deleteTmpImage).not.toHaveBeenCalled();
});

it.each([
  "success",
  "failure",
  "absent",
])("purge clears only its registry on %s, logging disk failures", async (outcome) => {
  const warnings: unknown[] = [];
  const deps = makeDeps({
    ...(outcome === "absent"
      ? {}
      : {
          deleteConversationImages: async () => {
            if (outcome === "failure") throw new Error("disk unavailable");
          },
        }),
  });
  const { createLogger } = await import("@dispatch/kernel");
  const svc = createVisionHandoffService({
    ...deps,
    logger: createLogger(
      {},
      {
        emit: (record) => {
          warnings.push(record);
        },
      },
      { now: () => 0, newId: () => "test" },
    ),
  });
  for (const conversationId of ["deleted", "keep"]) {
    await svc.prepareForProvider(
      [{ role: "user", chunks: [{ type: "image", url: "data:image/png;base64,aA==" }] }],
      "umans/umans-glm-5.2",
      { conversationId },
    );
    expect(svc.getRegisteredImage(conversationId, 1)).toBeDefined();
  }
  await svc.purgeConversationImages("deleted");
  await svc.purgeConversationImages("deleted");
  expect(svc.getRegisteredImage("deleted", 1)).toBeUndefined();
  expect(svc.getRegisteredImage("keep", 1)).toBeDefined();
  const failures = warnings.filter((r) => (r as { level?: string }).level === "warn");
  expect(failures).toHaveLength(outcome === "failure" ? 2 : 0);
  if (outcome === "failure")
    expect(failures[0]).toMatchObject({
      msg: "vision-handoff: failed to purge conversation images",
      attributes: { conversationId: "deleted", error: "disk unavailable" },
    });
});
