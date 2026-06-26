/**
 * Pure decision helpers for the vision handoff.
 *
 * No I/O, no ambient state. The shell (the extension + the service) injects the
 * effects (credential store lookups, provider streaming). This module owns only
 * the policy: which model is vision-capable, how to build a transcription
 * request, and how to fold a provider's streamed text into a description.
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
 * no vision-capable model is available (the handoff degrades: images are
 * replaced with a placeholder note). Pure given the (async) lookup — no
 * ambient state, no side effects.
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
    // lookup for known vision families (kimi). This avoids a round-trip to
    // listModels for the common case.
    const slash = name.indexOf("/");
    const modelId = slash >= 0 ? name.slice(slash + 1) : name;
    if (isVisionModelId(modelId)) return name;
    const info = await getInfo(name);
    if (info?.vision === true) return name;
  }
  return undefined;
}

/**
 * Fold a provider's streamed events into a single text string (the
 * transcription). Pure given the async iterable — collects `text-delta` events,
 * ignores everything else (reasoning, usage, tool-calls, errors). If the stream
 * yields an error event, it is surfaced as a thrown Error so the caller can
 * decide how to degrade (placeholder vs. fail). Pure: input → output, no I/O.
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
 * Build the prompt sent to the vision model to transcribe an image. Kept here
 * (pure) so the prompt is testable and stable. The prompt asks for a thorough
 * description so the text-only model has enough detail to reason about the
 * image's contents. Pure.
 *
 * @param userQuestion  The user's own message text (may be empty) — passed so
 *   the vision model can tailor its description to what the user actually asked.
 */
export function buildTranscriptionPrompt(userQuestion: string | undefined): string {
  const focus =
    userQuestion && userQuestion.trim().length > 0
      ? `\n\nThe user asked: "${userQuestion.trim()}". Focus your description on what is relevant to that question, but still describe the whole image.`
      : "";
  return (
    "Describe this image in detail. Include: the overall scene/subject, " +
    "visible text (transcribe verbatim), key objects, layout, colors, and any " +
    "notable details a developer or user would need to understand the image." +
    focus
  );
}

/**
 * Format a single image's transcription as a text chunk string for the
 * persisted user message. The note names the vision model so the consumer knows
 * the description's provenance. Pure.
 */
export function formatTranscriptionText(
  description: string,
  visionModelName: string | undefined,
): string {
  const source = visionModelName ?? "vision model";
  return `[Image analysis (via ${source})]: ${description}`;
}

/**
 * Placeholder text used when NO vision-capable model is available (the
 * degraded path). Pure.
 */
export function formatNoVisionPlaceholder(): string {
  return (
    "[Image attached — no vision-capable model is available to analyze it. " +
    "Install or configure a vision-capable model (e.g. kimi) to enable image analysis.]"
  );
}
