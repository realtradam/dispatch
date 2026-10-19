/**
 * Pure decision helpers for the vision handoff.
 *
 * No I/O, no ambient state. The shell (the extension + the service) injects the
 * effects (credential store lookups, orchestrator, provider streaming). This
 * module owns only the policy: which model is vision-capable, how to format
 * image placeholders for non-vision models, and how to format the
 * consultation tool's result.
 */

import type { ModelInfo, ProviderEvent, ToolContract } from "@dispatch/kernel";
import { isVisionModelId } from "@dispatch/openai-stream";

/**
 * Whether a model is vision-capable, given its catalog name and (optional)
 * resolved `ModelInfo`. When `ModelInfo.vision` is present it is authoritative;
 * otherwise fall back to the hardcoded name heuristic ({@link isVisionModelId}).
 *
 * The `modelName` is the `<credentialName>/<model>` catalog form; the heuristic
 * inspects the model SEGMENT (after the first `/`) so `umans/kimi-k2.7` → the
 * `kimi-k2.7` segment is checked. Pure.
 */
export function isVisionCapable(
  modelName: string | undefined,
  info: ModelInfo | undefined,
): boolean {
  // When ModelInfo explicitly reports vision (true OR false), it is authoritative
  // — an explicit false overrides the name heuristic (a provider that KNOWS a
  // model is non-vision wins over the name guess).
  if (info?.vision !== undefined) return info.vision;
  if (modelName === undefined) return false;
  const slash = modelName.indexOf("/");
  const modelId = slash >= 0 ? modelName.slice(slash + 1) : modelName;
  return isVisionModelId(modelId);
}

/**
 * Find a vision-capable model name in a catalog, given a lookup that resolves a
 * `<credentialName>/<model>` → `ModelInfo`. Returns `undefined` when no vision-
 * capable model is available. Pure given the (async) lookup.
 *
 * When a `preferred` name is given AND it is vision-capable (per
 * {@link isVisionCapable}), it is returned immediately — this honors the
 * per-conversation `compactionModel` setting. Otherwise the catalog is scanned
 * in order for the first vision-capable model (the auto-select behavior).
 *
 * Note: this only decides which NAME to pick based on vision capability; it
 * does NOT check whether the model is resolvable to a provider (that is the
 * shell's job in `resolveVisionModel`, which falls back to the catalog scan
 * when a preferred name turns out to be unresolvable).
 *
 * @param catalog    The full list of model names (`<credentialName>/<model>`).
 * @param getInfo    Async lookup of a model name → ModelInfo (from the credential store).
 * @param exclude    Optional model name to skip (e.g. the current non-vision model).
 * @param preferred  Optional model name to prefer (the `compactionModel` setting).
 *                   Used when it is vision-capable; ignored otherwise.
 */
export async function findVisionModelName(
  catalog: readonly string[],
  getInfo: (modelName: string) => Promise<ModelInfo | undefined>,
  exclude?: string,
  preferred?: string,
): Promise<string | undefined> {
  // Preferred path: honor the configured compaction model when it is vision-
  // capable. `isVisionCapable` consults ModelInfo (authoritative) and falls
  // back to the name heuristic, so a preferred model is accepted whether or
  // not it happens to be listed in the catalog.
  if (preferred !== undefined && preferred !== exclude) {
    const info = await getInfo(preferred);
    if (isVisionCapable(preferred, info)) return preferred;
  }

  // Fallback: scan the catalog in order for the first vision-capable model.
  for (const name of catalog) {
    if (exclude !== undefined && name === exclude) continue;
    // Fast path: the name heuristic lets us short-circuit without an async
    // lookup for known vision families (kimi).
    const slash = name.indexOf("/");
    const modelId = slash >= 0 ? name.slice(slash + 1) : name;
    if (isVisionModelId(modelId)) return name;
    const info = await getInfo(name);
    if (info?.vision === true) return name;
  }
  return undefined;
}

/**
 * Fold a provider's streamed events into a single text string. Pure given the
 * async iterable — collects `text-delta` events, ignores everything else
 * (reasoning, usage, tool-calls). If the stream yields an error event, it is
 * surfaced as a thrown Error so the caller can decide how to degrade.
 *
 * When a `signal` is provided, each `next()` is raced against it (promise
 * coordination only — no I/O). If the signal fires while a `next()` is pending,
 * the collection stops promptly (no waiting on a hanging provider) and ABORTS
 * (`throw`s AbortSignal-based) so the caller can propagate cancellation rather
 * than caching a failure placeholder.
 */
export async function collectTextFromStream(
  stream: AsyncIterable<ProviderEvent>,
  signal?: AbortSignal,
): Promise<string> {
  let text = "";
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      const nextPromise: Promise<IteratorResult<ProviderEvent>> = iterator.next();
      let result: IteratorResult<ProviderEvent>;
      if (signal !== undefined) {
        void nextPromise.catch(() => {});
        result = await new Promise<IteratorResult<ProviderEvent>>((resolve) => {
          const onAbort = () => resolve({ done: true, value: undefined });
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
          void nextPromise.then((r) => {
            signal.removeEventListener("abort", onAbort);
            resolve(r);
          });
        });
      } else {
        result = await nextPromise;
      }
      if (result.done) break;
      const event = result.value;
      if (event.type === "text-delta") {
        text += event.delta;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
    // Abort-driven completion: the abort race resolved as done. Surface it as a
    // thrown AbortError so callers treat it as cancellation, not as a normal
    // end-of-stream (avoids caching a failure placeholder).
    if (signal?.aborted) {
      throw createAbortError();
    }
    return text;
  } finally {
    // Best-effort request upstream cleanup (release reader locks / cancel HTTP
    // streams). On abort the underlying provider `next()` may still be pending;
    // never await a hanging `return()` and swallow any rejection so settling as
    // aborted is never delayed or broken.
    try {
      const returnFn = iterator.return;
      if (returnFn) {
        const p = returnFn.call(iterator);
        if (p) void p.catch(() => {});
      }
    } catch {
      // swallow
    }
  }
}

function createAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Format the placeholder text that replaces an `image` chunk when a non-vision
 * model is active. The placeholder tells the model an image is attached and it
 * should call `consult_vision` to analyze it — the model drives the analysis
 * (asking a specific question) rather than receiving a pre-emptive generic dump.
 *
 * @param imageId  The 1-based ID assigned to this image (used by the tool to
 *   look up the registered image data).
 * Pure.
 */
export function formatImagePlaceholder(imageId: number): string {
  return (
    `[Image ${imageId} attached — you cannot view images. Call the ` +
    `consult_vision tool with imageIds=[${imageId}] and a specific question ` +
    `to analyze it via a vision-capable model.]`
  );
}

/**
 * Placeholder text used when NO vision-capable model is available (the
 * degraded path — the tool cannot function). Pure.
 */
export function formatNoVisionPlaceholder(): string {
  return (
    "[Image attached — no vision-capable model is available to analyze it. " +
    "Install or configure a vision-capable model (e.g. kimi) to enable image analysis.]"
  );
}

/**
 * Placeholder text used when an image's bytes are no longer available (the tmp
 * file is gone — e.g. the image dir did not survive a reboot). Substituted
 * instead of failing the turn. Pure.
 */
export function formatImageUnavailablePlaceholder(): string {
  return "[Image unavailable — the original file is no longer on disk.]";
}

/**
 * Maximum length of the consultation title body (matching the conversation
 * store's `TITLE_MAX`). The question is truncated to this before the
 * `"IMAGE - "` prefix is applied so the consultation tab's title stays in line
 * with the store's own title-derivation limit.
 */
const CONSULTATION_TITLE_MAX = 80;

/**
 * Format the title for a vision consultation conversation tab. The title is
 * `"IMAGE - "` prefixed to the (truncated) question so the tab is visually
 * distinguishable from normal conversation tabs. The question is truncated to
 * match the conversation store's title-derivation limit (`TITLE_MAX = 80`).
 *
 * Pure.
 *
 * @param question  The question the model asked the vision model.
 */
export function formatConsultationTitle(question: string): string {
  const body =
    question.length > CONSULTATION_TITLE_MAX
      ? `${question.slice(0, CONSULTATION_TITLE_MAX)}…`
      : question;
  return `IMAGE - ${body}`;
}

/**
 * Format the `consult_vision` tool's result string. Returns the conversation ID
 * (so the model / user can continue the vision consultation), the vision model's
 * response, and a note that follow-up questions use the agent-management tools
 * (`send_agent_message` / `read_agent`) — the conversation ID is the bridge. The
 * dispatch CLI remains a fallback for terminal use and recovery.
 *
 * Pure.
 *
 * @param conversationId  The new vision consultation conversation ID.
 * @param response        The vision model's answer to the model's question.
 */
export function formatConsultResult(conversationId: string, response: string): string {
  const trimmed = response.trim();
  return (
    `Vision consultation opened in conversation ${conversationId}.\n\n` +
    `Response: ${trimmed}\n\n` +
    `To ask follow-up questions about this image, use the agent-management ` +
    `tools with this conversation ID: send_agent_message (to ask another ` +
    `question) and read_agent (to read the latest reply). The dispatch CLI ` +
    `(conversation: ${conversationId}) remains a fallback for terminal use.`
  );
}

// ── Model-aware vision tool filtering (plan §12) ────────────────────────────

/**
 * Filter the tool set for a turn based on whether the active model is
 * vision-capable. Complementary visibility (plan §12):
 *
 * | capability      | consult_vision | read_image |
 * |-----------------|---------------:|-----------:|
 * | vision-capable  |        hidden  |  available |
 * | non-vision      |     available  |     hidden |
 *
 * A `toolPolicy: none` conversation still receives neither tool — the final
 * policy application (in session-orchestrator) runs AFTER this filter, so it
 * strips everything regardless. Tool-name matching is DATA (the kernel routes
 * tool-calls by name — the sanctioned string-keyed exception), so a name-based
 * filter is correct here.
 *
 * Pure.
 *
 * @param tools           The assembled tool set for this turn.
 * @param visionCapable   Whether the turn's resolved model can see images.
 */
export function filterVisionTools(
  tools: readonly ToolContract[],
  visionCapable: boolean,
): readonly ToolContract[] {
  if (visionCapable) {
    // Vision-capable model: it sees images natively, so it never needs to
    // consult another vision model. `read_image` stays (it lets the model pull
    // a filesystem image into context).
    return tools.filter((t) => t.name !== "consult_vision");
  }
  // Non-vision model: it cannot see images, so `read_image` is useless to it
  // (it would return images it cannot view). `consult_vision` stays (it lets
  // the model delegate image analysis to a vision-capable model).
  return tools.filter((t) => t.name !== "read_image");
}

// ── read_image tool pure helpers (plan §13) ─────────────────────────────────

/** Supported image extensions → MIME types. Pure data. */
export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/** Maximum number of images a single read_image call may return. */
export const READ_IMAGE_MAX_COUNT = 10;
/** Maximum size of a single image (bytes). */
export const READ_IMAGE_MAX_PER_FILE = 20 * 1024 * 1024; // 20 MiB
/** Maximum total size across all images in one call (bytes). */
export const READ_IMAGE_MAX_TOTAL = 50 * 1024 * 1024; // 50 MiB

/** The MIME type for an image path, or `undefined` when unsupported. Pure. */
export function mimeFromPath(path: string): string | undefined {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = base.slice(dot).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext];
}

/**
 * Resolve `path` against `cwd` to an absolute path and verify it stays WITHIN
 * `cwd` (working-directory containment — plan §13.2 point 3). Returns the
 * absolute path, or an error string. Absolute paths outside `cwd` and `..`
 * traversal that escapes `cwd` are rejected.
 *
 * Pure given the injected `resolve` (node:path).
 *
 * @param resolve  `node:path`'s `resolve` (injected so this is testable).
 * @param path     The model-supplied path (relative or absolute).
 * @param cwd      The working directory to resolve against and contain to.
 */
export function resolveAndContain(
  resolve: (base: string, rel: string) => string,
  path: string,
  cwd: string,
): { readonly abs: string } | { readonly error: string } {
  const abs = resolve(cwd, path);
  // Containment: the resolved path must equal cwd or live under it. Compare
  // with a trailing separator so a sibling like `/work-evil` is NOT treated as
  // inside `/work`.
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (abs !== cwd && !abs.startsWith(base)) {
    return { error: `Path "${path}" escapes the working directory.` };
  }
  return { abs };
}

/** A read_image result for a single image: the data URL + its metadata. */
export interface ReadImageEntry {
  /** The original (model-supplied) path. */
  readonly path: string;
  /** The resolved absolute path. */
  readonly abs: string;
  readonly mimeType: string;
  /** Decoded image size in bytes. */
  readonly size: number;
  /** `data:<mime>;base64,<...>` — the native image attachment URL. */
  readonly dataUrl: string;
}

/**
 * Validate a decoded image's size against the per-file and running total caps.
 * Returns `undefined` when valid, or an error string. Pure.
 */
export function validateImageSize(size: number, runningTotal: number): string | undefined {
  if (size > READ_IMAGE_MAX_PER_FILE) {
    return (
      `Image is ${formatBytes(size)} which exceeds the per-image limit of ` +
      `${formatBytes(READ_IMAGE_MAX_PER_FILE)}.`
    );
  }
  if (runningTotal + size > READ_IMAGE_MAX_TOTAL) {
    return `Total image size would exceed the limit of ${formatBytes(READ_IMAGE_MAX_TOTAL)}.`;
  }
  return undefined;
}

/**
 * Format a byte count as a human-readable string (e.g. `1.5 MiB`). Pure.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Format the text metadata for a read_image result (one line per image, with
 * the path, MIME type, and size). This is the `content` the model reads; the
 * actual image bytes travel as native `images` attachments. Pure.
 */
export function formatReadImageResult(entries: readonly ReadImageEntry[]): string {
  if (entries.length === 0) return "No images read.";
  const lines = entries.map((e) => `${e.path} — ${e.mimeType}, ${formatBytes(e.size)}`);
  return `Read ${entries.length} image${entries.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}
