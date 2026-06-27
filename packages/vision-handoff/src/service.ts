/**
 * Vision handoff service — the imperative shell that performs the universal,
 * provider-agnostic vision handoff.
 *
 * Two capabilities:
 * 1. **Transcription for non-vision models** (`transcribeForProvider`): when a
 *    user message carries images but the active model cannot see them, this
 *    calls a vision-capable model (resolved from the catalog — any provider) to
 *    describe each image, then replaces the image chunks with text. Universal:
 *    it uses the standard `ProviderContract.stream` interface, never a
 *    provider-specific vision endpoint.
 * 2. **`read_image` tool** (`readImageFile`): reads an image FILE from disk and
 *    transcribes it via a vision-capable model, returning the text description
 *    — so any model (vision or not) can analyze an image referenced in code.
 *
 * Effects (credential store, provider streaming, filesystem, fetch) are
 * injected. The pure decisions live in `pure.ts`. This shell wires them.
 */

import type { CredentialStore } from "@dispatch/credential-store";
import type {
  ChatMessage,
  Chunk,
  Logger,
  ModelInfo,
  ProviderContract,
  ProviderStreamOptions,
} from "@dispatch/kernel";
import { defineService, type ServiceHandle } from "@dispatch/kernel";
import {
  buildTranscriptionPrompt,
  collectTextFromStream,
  findVisionModelName,
  formatNoVisionPlaceholder,
  formatTranscriptionText,
  isVisionCapable,
} from "./pure.js";

/**
 * Resolved vision model — a provider + its model id, ready to stream from.
 */
export interface ResolvedVisionModel {
  readonly provider: ProviderContract;
  readonly model: string;
  readonly modelName: string;
}

/**
 * Dependencies the service needs — all injected (no ambient state).
 */
export interface VisionHandoffDeps {
  readonly credentialStore: CredentialStore;
  /** Resolve a `<credentialName>/<model>` → its provider + model id. */
  readonly resolveModel: (
    modelName: string,
  ) => { provider: ProviderContract; model: string } | undefined;
  /**
   * Read a file from disk as a base64 data URL. Injected so the shell controls
   * the filesystem edge (and tests inject a fake). Returns the data URL, or
   * throws on error (the caller surfaces it as a tool error).
   */
  readonly readFileAsDataUrl: (path: string, cwd?: string) => Promise<string>;
  /**
   * Fetch an HTTP(S) URL to a data URL (for http image sources). Injected so
   * tests inject a fake. Optional — when absent, HTTP image URLs are passed to
   * the vision provider as-is (it fetches them).
   */
  readonly fetchUrlAsDataUrl?: (url: string) => Promise<string>;
  readonly logger?: Logger;
}

export interface VisionHandoffService {
  /**
   * Whether a given model (by catalog name) is vision-capable. Uses the
   * credential store's ModelInfo + the name heuristic. Async because ModelInfo
   * may require a listModels round-trip (cached by the credential store).
   */
  readonly isVisionCapable: (modelName: string | undefined) => Promise<boolean>;

  /**
   * Resolve a vision-capable model from the catalog (any provider). Returns
   * `undefined` when none is available.
   */
  readonly resolveVisionModel: (excludeName?: string) => Promise<ResolvedVisionModel | undefined>;

  /**
   * Transcribe a single image URL to a text description via a vision-capable
   * model. Returns the description, or a placeholder string when no vision
   * model is available (does NOT throw — callers want graceful degradation).
   */
  readonly transcribeImage: (
    imageUrl: string,
    userQuestion: string | undefined,
    opts?: { readonly signal?: AbortSignal; readonly logger?: Logger },
  ) => Promise<string>;

  /**
   * Transform a message list for the provider: if the active model is
   * vision-capable, return messages unchanged (images pass through natively).
   * If NOT vision-capable, replace every `image` chunk with a text
   * description (transcribed via a vision model — once per unique image URL,
   * cached within the call) so a text-only model can still reason about the
   * images. Never throws — on failure an image becomes a placeholder note.
   *
   * The PERSISTED history is NOT modified by this (the caller persists the
   * original messages with images); this only transforms what the provider sees.
   */
  readonly transcribeForProvider: (
    messages: readonly ChatMessage[],
    currentModelName: string | undefined,
    opts?: { readonly signal?: AbortSignal; readonly logger?: Logger },
  ) => Promise<readonly ChatMessage[]>;

  /**
   * Read an image FILE from disk and transcribe it (the `read_image` tool's
   * core). Returns the description text. Throws on filesystem error (the tool
   * surfaces it as a tool-error result).
   */
  readonly readImageFile: (
    path: string,
    cwd: string | undefined,
    opts?: { readonly signal?: AbortSignal; readonly logger?: Logger },
  ) => Promise<string>;
}

export const visionHandoffHandle: ServiceHandle<VisionHandoffService> =
  defineService<VisionHandoffService>("vision-handoff/service");

/** Whether a message list contains any image chunks. Pure. */
function hasImageChunks(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => m.chunks.some((c) => c.type === "image"));
}

export function createVisionHandoffService(deps: VisionHandoffDeps): VisionHandoffService {
  const log = deps.logger;

  async function getInfo(modelName: string): Promise<ModelInfo | undefined> {
    return deps.credentialStore.getModelInfo(modelName);
  }

  async function resolveVisionModel(
    excludeName?: string,
  ): Promise<ResolvedVisionModel | undefined> {
    const catalog = await deps.credentialStore.listCatalog();
    const name = await findVisionModelName(catalog, getInfo, excludeName);
    if (name === undefined) return undefined;
    const resolved = deps.resolveModel(name);
    if (resolved === undefined) return undefined;
    return { provider: resolved.provider, model: resolved.model, modelName: name };
  }

  async function streamVisionText(
    vision: ResolvedVisionModel,
    imageUrl: string,
    prompt: string,
    opts?: { readonly signal?: AbortSignal; readonly logger?: Logger },
  ): Promise<string> {
    // Build a single-turn user message: [text prompt, image]. The vision model
    // receives the image natively via the OpenAI-compatible content array
    // (convertMessages serializes the image chunk to image_url).
    const userMessage: ChatMessage = {
      role: "user",
      chunks: [
        { type: "text", text: prompt },
        { type: "image", url: imageUrl },
      ],
    };
    const providerOpts: ProviderStreamOptions = {
      model: vision.model,
      // NOTE: temperature is deliberately OMITTED. Different vision providers
      // have different constraints (e.g. Moonshot/Kimi only allows temperature:
      // 1; others allow 0–2). Hardcoding any value risks an HTTP 400 from a
      // provider that rejects it. Omitting lets each provider use its own
      // default — the truly universal, provider-agnostic choice.
      // A short system prompt keeps the vision model focused on describing.
      systemPrompt:
        "You are a vision assistant. Describe images faithfully and thoroughly for a developer who cannot see them.",
    };
    const streamOpts: Parameters<ProviderContract["stream"]>[2] = {
      ...providerOpts,
      ...(opts?.logger !== undefined ? { logger: opts.logger } : {}),
    };
    const stream = vision.provider.stream([userMessage], [], streamOpts);
    return collectTextFromStream(stream);
  }

  const service: VisionHandoffService = {
    async isVisionCapable(modelName: string | undefined): Promise<boolean> {
      if (modelName === undefined) return false;
      const info = await getInfo(modelName);
      return isVisionCapable(modelName, info);
    },

    resolveVisionModel,

    async transcribeImage(
      imageUrl: string,
      userQuestion: string | undefined,
      opts?: { readonly signal?: AbortSignal; readonly logger?: Logger },
    ): Promise<string> {
      const vision = await resolveVisionModel();
      if (vision === undefined) {
        log?.warn("vision-handoff: no vision-capable model available for transcription");
        return formatNoVisionPlaceholder();
      }
      const prompt = buildTranscriptionPrompt(userQuestion);
      try {
        const description = await streamVisionText(vision, imageUrl, prompt, opts);
        const trimmed = description.trim();
        if (trimmed.length === 0) {
          return "[Image analysis produced no output.]";
        }
        return formatTranscriptionText(trimmed, vision.modelName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.warn("vision-handoff: transcription failed", { error: msg });
        return `[Image analysis failed: ${msg}]`;
      }
    },

    async transcribeForProvider(
      messages: readonly ChatMessage[],
      currentModelName: string | undefined,
      opts?: { readonly signal?: AbortSignal; readonly logger?: Logger },
    ): Promise<readonly ChatMessage[]> {
      // Fast path: no images anywhere → nothing to do.
      if (!hasImageChunks(messages)) return messages;

      // If the active model IS vision-capable, pass images through natively.
      if (currentModelName !== undefined) {
        const capable = await isVisionCapable(currentModelName, await getInfo(currentModelName));
        if (capable) return messages;
      }

      // Non-vision model: transcribe each unique image URL once (cached).
      const cache = new Map<string, string>();
      const userText = messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.chunks)
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(" ");

      async function transcribeCached(url: string): Promise<string> {
        const cached = cache.get(url);
        if (cached !== undefined) return cached;
        const description = await service.transcribeImage(url, userText, opts);
        cache.set(url, description);
        return description;
      }

      const result: ChatMessage[] = [];
      for (const msg of messages) {
        if (!msg.chunks.some((c) => c.type === "image")) {
          result.push(msg);
          continue;
        }
        // Replace image chunks with transcribed text chunks; keep all else.
        const newChunks: Chunk[] = [];
        for (const chunk of msg.chunks) {
          if (chunk.type === "image") {
            const description = await transcribeCached(chunk.url);
            newChunks.push({ type: "text", text: description });
          } else {
            newChunks.push(chunk);
          }
        }
        result.push({ role: msg.role, chunks: newChunks });
      }
      return result;
    },

    async readImageFile(
      path: string,
      cwd: string | undefined,
      opts?: { readonly signal?: AbortSignal; readonly logger?: Logger },
    ): Promise<string> {
      const dataUrl = await deps.readFileAsDataUrl(path, cwd);
      return service.transcribeImage(dataUrl, undefined, opts);
    },
  };

  return service;
}
