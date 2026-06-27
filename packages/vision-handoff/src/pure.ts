/**
 * Pure decision helpers for the vision handoff.
 *
 * No I/O, no ambient state. The shell (the extension + the service) injects the
 * effects (credential store lookups, orchestrator, provider streaming). This
 * module owns only the policy: which model is vision-capable, how to format
 * image placeholders for non-vision models, and how to format the
 * consultation tool's result.
 */

import type { ModelInfo, ProviderEvent } from "@dispatch/kernel";
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
 * Find the first vision-capable model name in a catalog, given a lookup that
 * resolves a `<credentialName>/<model>` → `ModelInfo`. Returns `undefined` when
 * no vision-capable model is available. Pure given the (async) lookup.
 *
 * @param catalog  The full list of model names (`<credentialName>/<model>`).
 * @param getInfo  Async lookup of a model name → ModelInfo (from the credential store).
 * @param exclude  Optional model name to skip (e.g. the current non-vision model).
 */
export async function findVisionModelName(
  catalog: readonly string[],
  getInfo: (modelName: string) => Promise<ModelInfo | undefined>,
  exclude?: string,
): Promise<string | undefined> {
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
 */
export async function collectTextFromStream(stream: AsyncIterable<ProviderEvent>): Promise<string> {
  let text = "";
  for await (const event of stream) {
    if (event.type === "text-delta") {
      text += event.delta;
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
  }
  return text;
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
 * Format the `consult_vision` tool's result string. Returns the conversation ID
 * (so the model / user can continue the vision consultation), the vision model's
 * response, and a note that follow-up questions use the dispatch CLI (the model
 * can load the `dispatch-cli` skill for the exact commands).
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
    `To ask follow-up questions about this image, use the dispatch CLI ` +
    `(conversation: ${conversationId}).`
  );
}
