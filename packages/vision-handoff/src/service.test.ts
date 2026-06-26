import type {
  ChatMessage,
  ModelInfo,
  ProviderContract,
  ProviderEvent,
  ProviderStreamOptions,
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
        _opts?: ProviderStreamOptions,
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
  const catalog = ["umans/kimi-k2.7", "umans/glm-5.2"];
  const infoMap: Record<string, ModelInfo> = {
    "umans/kimi-k2.7": { id: "kimi-k2.7", vision: true },
    "umans/glm-5.2": { id: "glm-5.2" },
  };
  return {
    credentialStore: {
      listCatalog: vi.fn(async () => catalog),
      getModelInfo: vi.fn(async (name: string) => infoMap[name]),
      resolve: vi.fn((name: string) => {
        if (name === "umans/kimi-k2.7") return { providerId: "umans", model: "kimi-k2.7" };
        if (name === "umans/glm-5.2") return { providerId: "umans", model: "glm-5.2" };
        return undefined;
      }),
    },
    resolveModel: vi.fn((name: string) =>
      name === "umans/kimi-k2.7" || name === "umans/glm-5.2"
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
    expect(await svc.isVisionCapable("umans/kimi-k2.7")).toBe(true);
  });

  it("returns false for glm-5.2", async () => {
    const svc = createVisionHandoffService(makeDeps());
    expect(await svc.isVisionCapable("umans/glm-5.2")).toBe(false);
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
    expect(vision?.modelName).toBe("umans/kimi-k2.7");
    expect(vision?.model).toBe("kimi-k2.7");
  });

  it("excludes the given model", async () => {
    const svc = createVisionHandoffService(makeDeps());
    const vision = await svc.resolveVisionModel("umans/kimi-k2.7");
    // kimi is the only vision model; excluding it → undefined.
    expect(vision).toBeUndefined();
  });
});

describe("VisionHandoffService.transcribeImage", () => {
  it("returns a formatted description from the vision model", async () => {
    const svc = createVisionHandoffService(makeDeps());
    const result = await svc.transcribeImage("data:image/png;base64,xxx", "what is this?");
    expect(result).toBe(
      "[Image analysis (via umans/kimi-k2.7)]: DESCRIPTION of data:image/png;base64,xxx",
    );
  });

  it("returns a placeholder when no vision model is available", async () => {
    const deps = makeDeps();
    // Empty catalog → no vision model.
    (deps.credentialStore.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const svc = createVisionHandoffService(deps);
    const result = await svc.transcribeImage("data:image/png;base64,xxx", undefined);
    expect(result).toContain("no vision-capable model");
  });

  it("returns an error note when the vision stream errors", async () => {
    const errorProvider: ProviderContract = {
      id: "umans",
      stream: vi.fn(async function* (): AsyncIterable<ProviderEvent> {
        yield { type: "error", message: "vision API down" };
      }),
    };
    const deps = makeDeps({
      resolveModel: vi.fn(() => ({ provider: errorProvider, model: "kimi-k2.7" })),
    });
    const svc = createVisionHandoffService(deps);
    const result = await svc.transcribeImage("data:image/png;base64,xxx", undefined);
    expect(result).toContain("Image analysis failed: vision API down");
  });
});

describe("VisionHandoffService.transcribeForProvider", () => {
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
    const result = await svc.transcribeForProvider(messages, "umans/kimi-k2.7");
    expect(result).toBe(messages); // same reference — no copy, no transcription
  });

  it("passes messages through unchanged when there are no images", async () => {
    const deps = makeDeps();
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [{ role: "user", chunks: [{ type: "text", text: "hi" }] }];
    const result = await svc.transcribeForProvider(messages, "umans/glm-5.2");
    expect(result).toBe(messages);
  });

  it("transcribes image chunks to text for a non-vision model", async () => {
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
    const result = await svc.transcribeForProvider(messages, "umans/glm-5.2");
    expect(result).toHaveLength(1);
    const chunks = result[0]?.chunks;
    expect(chunks).toHaveLength(2);
    expect(chunks?.[0]).toEqual({ type: "text", text: "Describe this" });
    // The image chunk was replaced with a transcribed text chunk.
    expect(chunks?.[1]?.type).toBe("text");
    expect((chunks?.[1] as { text: string }).text).toContain("Image analysis");
    expect((chunks?.[1] as { text: string }).text).toContain("img1");
  });

  it("caches transcription per unique image URL within a call", async () => {
    const deps = makeDeps();
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [
      {
        role: "user",
        chunks: [
          { type: "image", url: "data:image/png;base64,same" },
          { type: "image", url: "data:image/png;base64,same" },
        ],
      },
    ];
    const result = await svc.transcribeForProvider(messages, "umans/glm-5.2");
    const chunks = result[0]?.chunks;
    // Both image chunks → text, same description (cached).
    expect(chunks).toHaveLength(2);
    expect((chunks?.[0] as { text: string }).text).toBe((chunks?.[1] as { text: string }).text);
    // The vision provider was called only once (cache hit on the second).
    const provider = deps.resolveModel("umans/kimi-k2.7")?.provider;
    expect((provider?.stream as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("transcribes images in history messages too (non-vision model)", async () => {
    const deps = makeDeps();
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "image", url: "data:image/png;base64,hist" }] },
      { role: "assistant", chunks: [{ type: "text", text: "got it" }] },
      { role: "user", chunks: [{ type: "text", text: "and now?" }] },
    ];
    const result = await svc.transcribeForProvider(messages, "umans/glm-5.2");
    // First message's image chunk is now text.
    expect(result[0]?.chunks[0]?.type).toBe("text");
    expect((result[0]?.chunks[0] as { text: string }).text).toContain("Image analysis");
    // Assistant message unchanged.
    expect(result[1]?.chunks[0]?.type).toBe("text");
    // Last user message unchanged.
    expect(result[2]?.chunks[0]).toEqual({ type: "text", text: "and now?" });
  });

  it("uses a placeholder when no vision model is available (non-vision model)", async () => {
    const deps = makeDeps();
    (deps.credentialStore.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const svc = createVisionHandoffService(deps);
    const messages: ChatMessage[] = [
      { role: "user", chunks: [{ type: "image", url: "data:image/png;base64,abc" }] },
    ];
    const result = await svc.transcribeForProvider(messages, "umans/glm-5.2");
    expect((result[0]?.chunks[0] as { text: string }).text).toContain("no vision-capable model");
  });
});

describe("VisionHandoffService.readImageFile", () => {
  it("reads the file and transcribes it", async () => {
    const deps = makeDeps();
    const svc = createVisionHandoffService(deps);
    const result = await svc.readImageFile("screenshot.png", "/work");
    expect(deps.readFileAsDataUrl).toHaveBeenCalledWith("screenshot.png", "/work");
    expect(result).toContain("Image analysis");
    expect(result).toContain("FILE(screenshot.png)");
  });
});
