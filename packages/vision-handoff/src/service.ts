/**
 * Vision handoff service — the imperative shell that performs the universal,
 * provider-agnostic vision handoff.
 *
 * Two capabilities:
 * 1. **prepareForProvider** (`prepareForProvider`): when a user message carries
 *    images but the active model cannot see them, this replaces each image chunk
 *    with a numbered placeholder (telling the model to call `consult_vision`)
 *    and registers the image data in a per-conversation registry for tool
 *    access. Vision-capable models pass through unchanged (images flow natively).
 * 2. **consult_vision tool** (`consultVision`): opens a NEW conversation tab with
 *    a vision-capable model (resolved from the catalog — any provider), attaches
 *    the image(s) + the model's specific question, waits for the response, and
 *    returns the conversation ID + the vision model's answer. The model (e.g.
 *    GLM 5.2) directs the analysis — asking exactly what it needs — instead of
 *    receiving a pre-emptive generic dump. Follow-up questions go through the
 *    dispatch CLI (the conversation ID is the bridge), not another tool call.
 *
 * Effects (credential store, orchestrator, filesystem) are injected. The pure
 * decisions live in `pure.ts`. This shell wires them.
 */

import type { AgentManagementService } from "@dispatch/agent-management";
import type { CredentialStore } from "@dispatch/credential-store";
import type {
  ChatMessage,
  Chunk,
  ImageInput,
  Logger,
  ModelInfo,
  ProviderContract,
} from "@dispatch/kernel";
import { defineService, type ServiceHandle } from "@dispatch/kernel";
import {
  collectTextFromStream,
  findVisionModelName,
  formatConsultationTitle,
  formatConsultResult,
  formatImagePlaceholder,
  formatNoVisionPlaceholder,
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

/** A registered image (looked up by the consult_vision tool via imageId). */
interface RegisteredImage {
  readonly url: string;
  readonly mimeType?: string;
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
   * the filesystem edge. Returns the data URL, or throws on error.
   */
  readonly readFileAsDataUrl: (path: string, cwd?: string) => Promise<string>;
  /**
   * Lazily resolve the AgentManagementService (the typed handle from
   * `@dispatch/agent-management`). Vision consultations are started via its
   * `summon` method with `toolAccess: "none"` + a focused system prompt, so this
   * extension owns NO conversation-start/wait logic (plan §11). Returns
   * `undefined` when `agent-management` is not loaded — `consult_vision`
   * degrades with an error. Lazy so activation order doesn't matter.
   */
  readonly resolveAgentManagement?: () => AgentManagementService | undefined;
  /**
   * Get the per-conversation cached image transcriptions (imageUrl → text).
   * Used to avoid re-transcribing old images that were compacted to text on a
   * previous turn. Optional — when absent, compaction still works but
   * re-transcribes every turn (no caching).
   */
  readonly getImageTranscriptions?: (
    conversationId: string,
  ) => Promise<ReadonlyMap<string, string>>;
  /**
   * Upsert a single image transcription into the per-conversation cache.
   * Optional — paired with getImageTranscriptions.
   */
  readonly setImageTranscription?: (
    conversationId: string,
    imageUrl: string,
    transcription: string,
  ) => Promise<void>;
  /**
   * Save an image data URL to a tmp file and return a compact URL
   * (`/images/<conversationId>/<imageId>.<ext>`) that can be persisted in the
   * conversation store instead of the full data URL (which would be megabytes).
   * The frontend serves the image via `GET /images/...`; the provider resolves
   * it back to a data URL via {@link resolveImageUrl} at runtime. When `undefined`,
   * data URLs pass through unchanged (images persist in SQLite — the large-DB
   * path, for environments without tmp file support).
   */
  readonly saveImageToTmp?: (
    conversationId: string,
    dataUrl: string,
    mimeType?: string,
  ) => Promise<string>;
  /**
   * Resolve a compact URL (`/images/...`) back to a data URL by reading the tmp
   * file. Data URLs and HTTP URLs pass through unchanged. Paired with
   * {@link saveImageToTmp}.
   */
  readonly resolveImageUrl?: (url: string) => Promise<string>;
  /**
   * Delete a tmp image file (after it has been compacted to text — the
   * transcription is cached, the raw image is no longer needed). Best-effort:
   * errors are logged, not thrown.
   */
  readonly deleteTmpImage?: (compactUrl: string) => Promise<void>;
  /**
   * Delete all tmp images for a conversation (on conversation close).
   * Best-effort.
   */
  readonly deleteConversationImages?: (conversationId: string) => Promise<void>;
  /**
   * Read the global vision settings (image compaction limit + compaction
   * model). Used by `consultVision` so the `consult_vision` tool honors the
   * configured compaction model when one is set (null = auto-select). Backed by
   * the conversation store's `getVisionSettings`. Optional — when absent,
   * `consult_vision` uses the auto-select catalog scan (legacy behavior).
   */
  readonly getVisionSettings?: () => Promise<{
    readonly imageLimit: number;
    readonly compactionModel: string | null;
  }>;
  readonly logger?: Logger;
}

export interface VisionHandoffService {
  /**
   * Whether a given model (by catalog name) is vision-capable. Uses the
   * credential store's ModelInfo + the name heuristic.
   */
  readonly isVisionCapable: (modelName: string | undefined) => Promise<boolean>;

  /**
   * Store images to tmp files and return compact URLs. Each input image's data
   * URL is saved to `/tmp/dispatch/images/<conversationId>/<uuid>.<ext>` and
   * replaced with a compact HTTP path (`/images/<conversationId>/<uuid>.<ext>`)
   * so the persisted conversation store holds a tiny string, not megabytes of
   * base64. When `saveImageToTmp` is not configured, data URLs pass through
   * unchanged (backward compatible).
   */
  readonly storeImages: (
    conversationId: string,
    images: readonly ImageInput[],
  ) => Promise<readonly ImageInput[]>;

  /**
   * Delete all tmp images for a conversation (on close). Best-effort.
   */
  readonly purgeConversationImages: (conversationId: string) => Promise<void>;

  /**
   * Resolve a vision-capable model from the catalog (any provider). When a
   * `preferredName` is given and it is vision-capable AND resolvable, it is
   * used; otherwise the catalog is scanned for the first vision-capable model
   * (the auto-select behavior). Returns `undefined` when none is available.
   */
  readonly resolveVisionModel: (
    excludeName?: string,
    preferredName?: string,
  ) => Promise<ResolvedVisionModel | undefined>;

  /**
   * Transform a message list for the provider: if the active model is
   * vision-capable, return messages unchanged (images pass through natively).
   * If NOT vision-capable, replace every `image` chunk with a numbered
   * placeholder (telling the model to call `consult_vision`) and register the
   * image data in the per-conversation registry for tool access. The PERSISTED
   * history is NOT modified — only what the provider sees. Never throws.
   */
  readonly prepareForProvider: (
    messages: readonly ChatMessage[],
    currentModelName: string | undefined,
    opts?: {
      readonly conversationId?: string;
      readonly imageLimit?: number;
      readonly compactionModel?: string | null;
      readonly signal?: AbortSignal;
      readonly logger?: Logger;
    },
  ) => Promise<readonly ChatMessage[]>;

  /**
   * Look up a registered image by conversation ID + image ID. Returns
   * `undefined` when the image isn't registered (e.g. after a server restart).
   */
  readonly getRegisteredImage: (
    conversationId: string,
    imageId: number,
  ) => RegisteredImage | undefined;

  /**
   * Open a NEW vision consultation conversation: attach image(s) + the model's
   * question to a vision-capable model, wait for the response, and return the
   * conversation ID + the vision model's answer. The model drives the analysis
   * — it asks exactly what it needs. Follow-ups go through the dispatch CLI.
   *
   * @returns The conversation ID + the vision model's response text, or an
   *   error string (never throws — the tool surfaces it).
   */
  readonly consultVision: (
    question: string,
    opts: {
      readonly conversationId: string;
      readonly imageIds?: readonly number[];
      readonly path?: string;
      readonly cwd?: string;
      readonly signal?: AbortSignal;
      readonly logger?: Logger;
    },
  ) => Promise<
    { readonly conversationId: string; readonly response: string } | { readonly error: string }
  >;
}

export const visionHandoffHandle: ServiceHandle<VisionHandoffService> =
  defineService<VisionHandoffService>("vision-handoff/service");

/** Whether a message list contains any image chunks. Pure. */
function hasImageChunks(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => m.chunks.some((c) => c.type === "image"));
}

export function createVisionHandoffService(deps: VisionHandoffDeps): VisionHandoffService {
  const log = deps.logger;

  // Per-conversation image registry: conversationId → (imageId → image data).
  // Populated by prepareForProvider; consulted by the consult_vision tool.
  // In-memory only (cleared on restart — the user re-pastes if needed).
  const imageRegistry = new Map<string, Map<number, RegisteredImage>>();

  async function getInfo(modelName: string): Promise<ModelInfo | undefined> {
    return deps.credentialStore.getModelInfo(modelName);
  }

  async function resolveVisionModel(
    excludeName?: string,
    preferredName?: string,
  ): Promise<ResolvedVisionModel | undefined> {
    const catalog = await deps.credentialStore.listCatalog();
    // `findVisionModelName` honors a vision-capable `preferredName` first, then
    // falls back to the catalog scan. A preferred name that is vision-capable
    // but NOT resolvable to a provider (e.g. its provider extension isn't
    // loaded) must still fall back to the catalog scan — so when the selected
    // name was the preference and it doesn't resolve, retry without it.
    let name = await findVisionModelName(catalog, getInfo, excludeName, preferredName);
    let resolved = name !== undefined ? deps.resolveModel(name) : undefined;
    if (resolved === undefined && preferredName !== undefined && name === preferredName) {
      name = await findVisionModelName(catalog, getInfo, excludeName);
      resolved = name !== undefined ? deps.resolveModel(name) : undefined;
    }
    if (name === undefined || resolved === undefined) return undefined;
    return { provider: resolved.provider, model: resolved.model, modelName: name };
  }

  /**
   * Compact images for a vision-capable model: when the conversation has more
   * image chunks than the limit, the oldest images are transcribed to text
   * (one-time, cached in the conversation store) and stripped from the
   * provider messages. Recent images (within the limit) stay native.
   *
   * The persisted history is NOT modified — only the provider's view.
   * Transcriptions are cached so they're reused on subsequent turns (no
   * re-transcription). When no caching deps are available, it still works but
   * re-transcribes every turn.
   */
  async function compactImagesForVisionModel(
    messages: readonly ChatMessage[],
    opts:
      | {
          readonly conversationId?: string;
          readonly imageLimit?: number;
          readonly compactionModel?: string | null;
          readonly signal?: AbortSignal;
          readonly logger?: Logger;
        }
      | undefined,
    currentModelName: string | undefined,
  ): Promise<readonly ChatMessage[]> {
    void currentModelName; // reserved for future model-specific compaction logic
    const limit = opts?.imageLimit;
    // No limit or limit <= 0 → pass all images through (compaction disabled).
    if (limit === undefined || limit <= 0) return messages;

    // Collect all image chunks in order (oldest first, across all messages).
    const imageEntries: { msgIdx: number; chunkIdx: number; url: string }[] = [];
    for (const [mi, msg] of messages.entries()) {
      for (const [ci, chunk] of msg.chunks.entries()) {
        if (chunk.type === "image") {
          imageEntries.push({ msgIdx: mi, chunkIdx: ci, url: chunk.url });
        }
      }
    }

    // If within the limit, pass everything through natively.
    if (imageEntries.length <= limit) return messages;

    // The oldest (imageEntries.length - limit) images need transcription.
    const toTranscribeCount = imageEntries.length - limit;
    const toTranscribe = imageEntries.slice(0, toTranscribeCount);

    // Load cached transcriptions.
    const convId = opts?.conversationId;
    const cache =
      convId !== undefined && deps.getImageTranscriptions !== undefined
        ? await deps.getImageTranscriptions(convId)
        : new Map<string, string>();

    // Transcribe any that aren't cached yet (via the vision model).
    const transcriptions = new Map<string, string>(cache);
    const vision = await resolveVisionModel(undefined, opts?.compactionModel ?? undefined);
    for (const entry of toTranscribe) {
      if (transcriptions.has(entry.url)) continue;
      if (vision === undefined) {
        // No vision model available for transcription — use a placeholder.
        transcriptions.set(
          entry.url,
          "[Image was compacted — no vision model available to transcribe it.]",
        );
        continue;
      }
      try {
        const prompt =
          "Describe this image in detail. Include visible text (transcribe verbatim), " +
          "key objects, layout, and notable details. This description will replace " +
          "the image in a conversation history, so be thorough.";
        const userMessage: ChatMessage = {
          role: "user",
          chunks: [
            { type: "text", text: prompt },
            { type: "image", url: entry.url },
          ],
        };
        const stream = vision.provider.stream([userMessage], [], {
          model: vision.model,
          systemPrompt:
            "You are a vision assistant. Describe images faithfully and thoroughly. " +
            "Do not use any tools — just use your vision to see the image and describe it directly.",
        });
        const description = (await collectTextFromStream(stream)).trim();
        const text =
          description.length > 0 ? description : "[Image transcription produced no output.]";
        transcriptions.set(entry.url, text);
        // Cache it in the conversation store (if available).
        if (convId !== undefined && deps.setImageTranscription !== undefined) {
          await deps.setImageTranscription(convId, entry.url, text);
        }
        // The image has been transcribed to text — delete the tmp file
        // (the transcription is cached, the raw image is no longer needed).
        if (deps.deleteTmpImage !== undefined) {
          try {
            await deps.deleteTmpImage(entry.url);
          } catch {
            // Best-effort — don't let cleanup failure break the turn.
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.warn("vision-handoff: image compaction transcription failed", { error: msg });
        transcriptions.set(entry.url, `[Image transcription failed: ${msg}]`);
      }
    }

    // Build the provider messages: replace transcribed images with text,
    // keep recent images (within the limit) native.
    const transcribedUrls = new Set(toTranscribe.map((e) => e.url));
    const result: ChatMessage[] = [];
    for (const msg of messages) {
      if (!msg.chunks.some((c) => c.type === "image")) {
        result.push(msg);
        continue;
      }
      const newChunks: Chunk[] = [];
      for (const chunk of msg.chunks) {
        if (chunk.type === "image" && transcribedUrls.has(chunk.url)) {
          const transcription = transcriptions.get(chunk.url);
          if (transcription !== undefined) {
            newChunks.push({ type: "text", text: `[Compacted image]: ${transcription}` });
          } else {
            newChunks.push(chunk); // fallback: keep the image
          }
        } else {
          newChunks.push(chunk);
        }
      }
      result.push({ role: msg.role, chunks: newChunks });
    }
    return result;
  }

  async function resolveImageUrlsInMessages(
    messages: readonly ChatMessage[],
  ): Promise<readonly ChatMessage[]> {
    const resolveImageUrl = deps.resolveImageUrl;
    if (resolveImageUrl === undefined) return messages;
    let hasCompact = false;
    for (const msg of messages) {
      if (msg.chunks.some((c) => c.type === "image")) {
        hasCompact = true;
        break;
      }
    }
    if (!hasCompact) return messages;
    const result: ChatMessage[] = [];
    for (const msg of messages) {
      if (!msg.chunks.some((c) => c.type === "image")) {
        result.push(msg);
        continue;
      }
      const newChunks: Chunk[] = [];
      for (const chunk of msg.chunks) {
        if (chunk.type === "image") {
          const dataUrl = await resolveImageUrl(chunk.url);
          newChunks.push({
            type: "image",
            url: dataUrl,
            ...(chunk.mimeType !== undefined ? { mimeType: chunk.mimeType } : {}),
          });
        } else {
          newChunks.push(chunk);
        }
      }
      result.push({ role: msg.role, chunks: newChunks });
    }
    return result;
  }

  const service: VisionHandoffService = {
    async isVisionCapable(modelName: string | undefined): Promise<boolean> {
      if (modelName === undefined) return false;
      const info = await getInfo(modelName);
      return isVisionCapable(modelName, info);
    },

    async storeImages(
      conversationId: string,
      images: readonly ImageInput[],
    ): Promise<readonly ImageInput[]> {
      if (deps.saveImageToTmp === undefined) return images;
      const result: ImageInput[] = [];
      for (const img of images) {
        if (img.url.startsWith("data:")) {
          const compactUrl = await deps.saveImageToTmp(conversationId, img.url, img.mimeType);
          result.push({
            url: compactUrl,
            ...(img.mimeType !== undefined ? { mimeType: img.mimeType } : {}),
          });
        } else {
          result.push(img);
        }
      }
      return result;
    },

    async purgeConversationImages(conversationId: string): Promise<void> {
      if (deps.deleteConversationImages === undefined) return;
      try {
        await deps.deleteConversationImages(conversationId);
      } catch (err) {
        log?.warn("vision-handoff: failed to purge conversation images", {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    resolveVisionModel,

    async prepareForProvider(
      messages: readonly ChatMessage[],
      currentModelName: string | undefined,
      opts?: {
        readonly conversationId?: string;
        readonly imageLimit?: number;
        readonly compactionModel?: string | null;
        readonly signal?: AbortSignal;
        readonly logger?: Logger;
      },
    ): Promise<readonly ChatMessage[]> {
      // Fast path: no images anywhere → nothing to do.
      if (!hasImageChunks(messages)) return messages;

      // Resolve compact URLs (/images/...) → data URLs for the provider.
      // The persisted chunks store compact URLs (tiny strings); the provider
      // needs data URLs (read from tmp files at runtime).
      const resolved = await resolveImageUrlsInMessages(messages);

      const isCapable =
        currentModelName !== undefined &&
        (await isVisionCapable(currentModelName, await getInfo(currentModelName)));

      // ── Vision-capable model: image compaction ──────────────────────────
      // When the conversation has more images than the limit, the oldest images
      // are transcribed to text (one-time, cached) and stripped from the
      // provider messages. Recent images (within the limit) stay native.
      if (isCapable) {
        return compactImagesForVisionModel(resolved, opts, currentModelName);
      }

      // ── Non-vision model: placeholders + consult_vision ──────────────────
      const vision = await resolveVisionModel(undefined, opts?.compactionModel ?? undefined);
      const convId = opts?.conversationId;

      const placeholderFn =
        vision !== undefined && convId !== undefined
          ? (id: number) => formatImagePlaceholder(id)
          : () => formatNoVisionPlaceholder();

      // Replace each image chunk with a numbered placeholder. Assign sequential
      // 1-based IDs across all messages and register each image in the
      // per-conversation registry so the consult_vision tool can look it up.
      let seqId = 0;
      const result: ChatMessage[] = [];
      for (const msg of resolved) {
        if (!msg.chunks.some((c) => c.type === "image")) {
          result.push(msg);
          continue;
        }
        const newChunks: Chunk[] = [];
        for (const chunk of msg.chunks) {
          if (chunk.type === "image") {
            seqId++;
            if (convId !== undefined && vision !== undefined) {
              let convImages = imageRegistry.get(convId);
              if (convImages === undefined) {
                convImages = new Map();
                imageRegistry.set(convId, convImages);
              }
              convImages.set(seqId, {
                url: chunk.url,
                ...(chunk.mimeType !== undefined ? { mimeType: chunk.mimeType } : {}),
              });
            }
            newChunks.push({ type: "text", text: placeholderFn(seqId) });
          } else {
            newChunks.push(chunk);
          }
        }
        result.push({ role: msg.role, chunks: newChunks });
      }
      return result;
    },

    getRegisteredImage(conversationId: string, imageId: number): RegisteredImage | undefined {
      return imageRegistry.get(conversationId)?.get(imageId);
    },

    async consultVision(
      question: string,
      opts: {
        readonly conversationId: string;
        readonly imageIds?: readonly number[];
        readonly path?: string;
        readonly cwd?: string;
        readonly signal?: AbortSignal;
        readonly logger?: Logger;
      },
    ): Promise<
      { readonly conversationId: string; readonly response: string } | { readonly error: string }
    > {
      const agentManagement = deps.resolveAgentManagement?.();
      if (agentManagement === undefined) {
        return {
          error: "Agent management is not available — cannot start a vision consultation.",
        };
      }

      // Honor the configured compaction model when one is set (null = auto-select).
      // The `consult_vision` tool doesn't carry the setting, so the service reads
      // the global vision settings here — mirroring how `prepareForProvider`
      // receives the per-turn `compactionModel` from the orchestrator.
      const settings =
        deps.getVisionSettings !== undefined ? await deps.getVisionSettings() : undefined;
      const preferred = settings?.compactionModel ?? undefined;
      const vision = await resolveVisionModel(undefined, preferred);
      if (vision === undefined) {
        return {
          error:
            "No vision-capable model is available in the catalog. Install or configure one (e.g. kimi) to enable image analysis.",
        };
      }

      // Collect image data URLs to attach.
      const images: ImageInput[] = [];
      if (opts.imageIds !== undefined) {
        for (const id of opts.imageIds) {
          const img = service.getRegisteredImage(opts.conversationId, id);
          if (img === undefined) {
            return {
              error: `Image ${id} is not registered. It may have been lost after a server restart — ask the user to re-paste the image.`,
            };
          }
          images.push({
            url: img.url,
            ...(img.mimeType !== undefined ? { mimeType: img.mimeType } : {}),
          });
        }
      }
      if (opts.path !== undefined) {
        try {
          const dataUrl = await deps.readFileAsDataUrl(opts.path, opts.cwd);
          images.push({ url: dataUrl });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `Failed to read image file "${opts.path}": ${msg}` };
        }
      }
      if (images.length === 0) {
        return {
          error:
            "No image to consult about. Provide imageIds (for pasted images) or path (for a file).",
        };
      }

      // Start a NEW consultation via the AgentManagementService — the ONLY
      // conversation-start/wait path (plan §11 hard isolation). The service
      // generates the conversation id, persists parentConversationId +
      // toolPolicy BEFORE the first turn, and starts the turn. We pass:
      //  - toolAccess: "none" → durable toolPolicy { mode: "none" } so the
      //    provider receives tools: [] on the first AND all later turns.
      //  - systemPrompt: the focused vision prompt (guidance, not enforcement).
      //  - wait: true → block for the child's first turn to settle and return
      //    the final assistant text (the parent receives text only — never
      //    child reasoning or tool data; plan §11 guarantee 4).
      //  - title: the "IMAGE - " prefixed question so the consultation tab is
      //    visually distinguishable (flows via summon → startTurn → orchestrator).
      //  - cwd/computerId: inherited from the caller by the service (plan §11
      //    guarantee 5); an explicit cwd override is forwarded when present.
      log?.info("vision-handoff: starting consultation", {
        visionModel: vision.modelName,
        imageCount: images.length,
        fromConversation: opts.conversationId,
      });

      const systemPrompt =
        "You are a vision assistant. A developer who cannot see images is asking you specific " +
        "questions about an image they attached. Answer their question precisely and thoroughly. " +
        "Do not use any tools — just use your vision to see the image and describe it directly.";

      const result = await agentManagement.summon({
        callerConversationId: opts.conversationId,
        model: vision.modelName,
        task: question,
        images,
        wait: true,
        open: true,
        toolAccess: "none",
        systemPrompt,
        title: formatConsultationTitle(question),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });

      if (!result.ok) {
        return { error: result.error.message };
      }

      const v = result.value;
      // The wait was ended by timeout (child still running) or the parent's
      // abort (child still running). Surface a typed outcome pointing to the
      // management tools for follow-up rather than an opaque failure.
      if (v.waitTimeout) {
        return {
          error:
            `Vision consultation timed out (conversation ${v.conversationId} is still ` +
            `running). Read its latest reply with read_agent, or the dispatch CLI.`,
        };
      }
      if (v.waitCancelled) {
        return {
          error: `Vision consultation was cancelled (conversation ${v.conversationId} is still running).`,
        };
      }

      const response = formatConsultResult(v.conversationId, v.reply ?? "");
      return { conversationId: v.conversationId, response };
    },
  };

  return service;
}
