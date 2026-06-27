import type {
  AgentEvent,
  ChatMessage,
  ModelInfo,
  ProviderContract,
  ProviderEvent,
  ToolContract,
} from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import { createVisionHandoffService, type VisionHandoffDeps } from "./service.js";

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
});

describe("VisionHandoffService.consultVision", () => {
  function makeOrchestratorDouble(response: string): {
    orchestrator: NonNullable<
      VisionHandoffDeps["resolveOrchestrator"] extends () => infer T ? T : never
    >;
    handleMessage: ReturnType<typeof vi.fn>;
  } {
    const handleMessage = vi.fn(
      async (input: {
        conversationId: string;
        text: string;
        onEvent: (event: AgentEvent) => void;
      }): Promise<void> => {
        input.onEvent({
          type: "text-delta",
          conversationId: input.conversationId,
          turnId: "t1",
          delta: response,
        });
        input.onEvent({
          type: "done",
          conversationId: input.conversationId,
          turnId: "t1",
          reason: "stop",
        });
      },
    );
    return { orchestrator: { handleMessage }, handleMessage };
  }

  it("opens a new consultation with a pasted image and returns convId + response", async () => {
    const deps = makeDeps();
    const { orchestrator, handleMessage } = makeOrchestratorDouble("The error is on line 12.");
    deps.resolveOrchestrator = () => orchestrator;
    const svc = createVisionHandoffService(deps);

    // Register an image first (as prepareForProvider would).
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "image", url: "data:image/png;base64,img1" }] },
    ];
    await svc.prepareForProvider(messages, "umans/umans-glm-5.2", { conversationId: "conv-1" });

    const result = await svc.consultVision("What error is shown?", {
      conversationId: "conv-1",
      imageIds: [1],
    });

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.conversationId).toBeTruthy();
      expect(result.response).toContain("line 12");
      expect(result.response).toContain(result.conversationId);
      expect(result.response).toContain("dispatch CLI");
    }
    // The orchestrator was called with the vision model + the image.
    expect(handleMessage).toHaveBeenCalledOnce();
    const call = handleMessage.mock.calls[0]?.[0];
    expect(call.modelName).toBe("umans/umans-kimi-k2.7");
    expect(call.images).toHaveLength(1);
    expect(call.images?.[0]?.url).toBe("data:image/png;base64,img1");
  });

  it("opens a consultation with a file path image", async () => {
    const deps = makeDeps();
    const { orchestrator } = makeOrchestratorDouble("It's a diagram.");
    deps.resolveOrchestrator = () => orchestrator;
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
    const { orchestrator } = makeOrchestratorDouble("response");
    deps.resolveOrchestrator = () => orchestrator;
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

  it("returns an error when no orchestrator is available", async () => {
    const deps = makeDeps();
    // No resolveOrchestrator provided.
    const svc = createVisionHandoffService(deps);
    const result = await svc.consultVision("What?", {
      conversationId: "conv-1",
      imageIds: [1],
    });
    expect("error" in result).toBe(true);
  });

  it("returns an error when no vision model is available", async () => {
    const deps = makeDeps();
    (deps.credentialStore.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { orchestrator } = makeOrchestratorDouble("response");
    deps.resolveOrchestrator = () => orchestrator;
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
    const { orchestrator } = makeOrchestratorDouble("response");
    deps.resolveOrchestrator = () => orchestrator;
    const svc = createVisionHandoffService(deps);
    const result = await svc.consultVision("What?", {
      conversationId: "conv-1",
    });
    expect("error" in result).toBe(true);
  });
});
