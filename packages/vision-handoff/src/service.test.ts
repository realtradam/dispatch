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
