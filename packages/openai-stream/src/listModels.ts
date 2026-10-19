import type { ModelInfo } from "@dispatch/kernel";
import type { FetchLike } from "@dispatch/trace-replay";

/**
 * Generic OpenAI-compatible model-list fetch + mapping. Lives in this library
 * (`@dispatch/openai-stream`) so any OpenAI-compatible provider extension can
 * reuse it without cross-extension code import (isolation-over-DRY: coupling
 * is via this typed library surface, not a sibling's internals).
 *
 * A provider extension supplies its own `id` (used in error labels) via
 * `createOpenAICompatProvider({ id })`.
 */

interface OpenAIModelEntry {
  readonly id: string;
  readonly context_length?: number;
  readonly context_window?: number;
  readonly max_context_length?: number;
  readonly max_tokens?: number;
  /**
   * Authoritative per-model capability metadata. `capabilities.vision` is set
   * by providers that report verifiable vision support (e.g. Hyper's
   * `/v1/models`), taking precedence over the {@link isVisionModelId} name
   * heuristic in {@link parseModelList}.
   */
  readonly capabilities?: {
    readonly vision?: boolean;
  };
  /**
   * Authoritative top-level vision capability reported by some providers'
   * `/models` endpoints (e.g. CoralBricks' `supports_image_input`). Treated the
   * same as `capabilities.vision`; the nested field wins when both are present.
   */
  readonly supports_image_input?: boolean;
}

interface OpenAIModelListResponse {
  readonly data: readonly OpenAIModelEntry[];
}

/**
 * The value of the Umans `/models/info` per-model `capabilities.supports_vision`
 * field. `true`/`false` are the direct native-image capabilities; `"via-handoff"`
 * means vision is only reachable through the Anthropic Messages endpoint server-
 * side handoff, not direct Chat-Completions image input.
 */
export type UmansVisionCapability = boolean | "via-handoff" | undefined;

/**
 * Maximum inline image parts the Umans gateway accepts in ONE
 * `/v1/chat/completions` request: **8**. Empirical, not reported by the API —
 * replay/bisect showed 8 images → 200 and 9 → 400 (the same opaque
 * `invalid_request_error` for every shape, independent of body size). It is
 * set for every Umans model so (a) the orchestrator clamps turn-start vision
 * compaction to it and (b) the provider adapter enforces it on the wire. If
 * Umans later reports a real per-model cap, feed that through
 * `parseUmansModelInfo` instead.
 */
export const UMANS_MAX_IMAGES = 8;

/**
 * The shape of a single entry in the Umans `/models/info` response. The response
 * is a JSON object keyed by model id, each value carrying metadata plus a
 * `capabilities` object that holds the runtime-relevant fields (`context_window`,
 * `max_completion_tokens`, `supports_vision`).
 */
export interface UmansModelInfoEntry {
  readonly name?: string;
  readonly display_name?: string;
  readonly capabilities?: {
    readonly context_window?: number;
    readonly max_completion_tokens?: number;
    readonly supports_vision?: UmansVisionCapability;
  };
}

/** The Umans `/models/info` response: a JSON object keyed by model id. */
export type UmansModelInfoResponse = Readonly<Record<string, UmansModelInfoEntry>>;

/**
 * Map an Umans `supports_vision` capability value to the `ModelInfo.vision`
 * boolean the orchestrator/vision-handoff consume.
 *
 * - `true`  → `true`  (accepts native image input in the Chat-Completions channel).
 * - `false` → `false` (no image input).
 * - `"via-handoff"` → `false`. This value means vision is reachable ONLY through
 *   the Anthropic Messages endpoint's server-side handoff (e.g. `umans-glm-5.2`),
 *   NOT through direct Chat-Completions image input. The `ModelInfo.vision: true`
 *   contract is specifically "image chunks are passed through to the provider
 *   serialized to its image-content format" over the provider's own stream channel
 *   — which the Umans provider (a Chat-Completions provider) cannot do for a
 *   via-handoff model. Marking it `true` would route native image content at a
 *   channel the model can't accept, breaking the pass-through. Marking it `false`
 *   routes images through the vision handoff (`consult_vision`) to a genuinely
 *   vision-native model (e.g. Kimi), which is the functioning path for these
 *   models. This is the deliberate, documented choice.
 * - `undefined` → `undefined` (capability unknown/absent; callers fall back to a
 *   name heuristic or treat as non-vision).
 */
export function visionFromUmansCapability(capability: UmansVisionCapability): boolean | undefined {
  if (capability === true) return true;
  if (capability === false || capability === "via-handoff") return false;
  return undefined;
}

/**
 * Whether a model id is vision-capable (can natively accept image input), by a
 * hardcoded name heuristic.
 *
 * This is a FALLBACK used ONLY where a provider's live endpoint reports no
 * capability field (e.g. the generic OpenAI-compatible `/models` list, which
 * has no image-capability signal). The Umans provider itself now reads the real
 * `/v1/models/info` endpoint (`listUmansModels`) and never relies on this guess
 * — its `supports_vision` field is authoritative. Matches the Umans Kimi
 * (`umans-kimi-*`) and Umans Qwen (`umans-qwen*`) families. Pure: id → boolean.
 */
export function isVisionModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes("umans-kimi") || lower.includes("umans-qwen");
}

/**
 * Pure mapping: raw OpenAI-compatible model list → ModelInfo[].
 * Extracts `contextWindow` from common field names (providers vary) and
 * detects vision capability via an EXPLICIT capability boolean when the
 * provider reports one — either the nested `capabilities.vision` (e.g. Hyper's
 * `/v1/models`) or the top-level `supports_image_input` (e.g. CoralBricks'
 * `/v1/models`). The nested field wins when both are present. Falls back to the
 * {@link isVisionModelId} name heuristic only when neither field is present
 * (backward compatibility for providers with no capability signal).
 * Extracted for direct unit testing with no I/O.
 */
export function parseModelList(data: readonly OpenAIModelEntry[]): readonly ModelInfo[] {
  return data.map((entry) => {
    const contextWindow =
      entry.context_length ?? entry.context_window ?? entry.max_context_length ?? entry.max_tokens;
    const explicitVision = entry.capabilities?.vision ?? entry.supports_image_input;
    const fallbackVision = isVisionModelId(entry.id);
    // Precedence: an explicit boolean capability wins; otherwise the name-based
    // heuristic (vision only reported when true — a non-vision-looking id emits
    // no vision key).
    const vision = typeof explicitVision === "boolean" ? explicitVision : fallbackVision;
    const hasVision = typeof explicitVision === "boolean" || vision === true;
    return {
      id: entry.id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(hasVision ? { vision } : {}),
    };
  });
}

/**
 * Pure mapping: the Umans `/models/info` response (a JSON object keyed by model
 * id) → ModelInfo[].
 *
 * Source of truth is the REAL capability metadata: `capabilities.supports_vision`
 * drives `vision` (via {@link visionFromUmansCapability}), and
 * `capabilities.context_window` drives `contextWindow`. Every model also gets
 * the known provider-wide image-count cap ({@link UMANS_MAX_IMAGES}) as
 * `maxImages` — the endpoint does not report it, but the gateway rejects more
 * than 8 image parts with an opaque HTTP 400. Only entries present in the
 * response are emitted (no hardcoded model list). Optionally includes the human
 * `display_name` when present. Pure: response map → ModelInfo[], no I/O.
 */
export function parseUmansModelInfo(response: UmansModelInfoResponse): readonly ModelInfo[] {
  return Object.entries(response).map(([id, entry]) => {
    const contextWindow = entry.capabilities?.context_window;
    const vision = visionFromUmansCapability(entry.capabilities?.supports_vision);
    const displayName = entry.display_name;
    return {
      id,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(vision !== undefined ? { vision } : {}),
      maxImages: UMANS_MAX_IMAGES,
    };
  });
}

/**
 * List Umans models by reading the real `/v1/models/info` endpoint (baseURL is
 * `https://api.code.umans.ai/v1`), mapping each model's reported
 * `capabilities.supports_vision` → `ModelInfo.vision` and its context window.
 *
 * Mirrors the Codex provider philosophy (read the live endpoint, no hardcoded
 * fallback list): model ids rotate and a stale guess silently hands callers the
 * wrong model. On failure this throws a labelled error (matching {@link listModels})
 * so the caller surfaces it rather than silently degrading.
 */
export async function listUmansModels(config: ListModelsConfig): Promise<readonly ModelInfo[]> {
  const effectiveFetch: FetchLike = config.fetchFn ?? fetch;
  const url = `${config.baseURL}/models/info`;

  let response: Response;
  try {
    response = await effectiveFetch(url, {
      method: "GET",
      headers: {
        Authorization: `${config.authScheme ?? "Bearer"} ${config.apiKey}`,
      },
    });
  } catch (err) {
    throw new Error(
      `listModels[${config.providerId}]: network error — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    throw new Error(`listModels[${config.providerId}]: HTTP ${response.status} — ${text}`);
  }

  const body = (await response.json()) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(
      `listModels[${config.providerId}]: unexpected response shape — expected a model-info map keyed by model id`,
    );
  }

  return parseUmansModelInfo(body as UmansModelInfoResponse);
}

export interface ListModelsConfig {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly fetchFn?: FetchLike;
  readonly providerId: string;
  /**
   * Authorization scheme prefix sent as `Authorization: <authScheme> <apiKey>`.
   * Default (absent): `"Bearer"`. Providers with a non-standard scheme (e.g.
   * Baseten's `Api-Key`) override it. Generic — the library names no feature.
   */
  readonly authScheme?: string;
}

export async function listModels(config: ListModelsConfig): Promise<readonly ModelInfo[]> {
  const effectiveFetch: FetchLike = config.fetchFn ?? fetch;
  const url = `${config.baseURL}/models`;

  let response: Response;
  try {
    response = await effectiveFetch(url, {
      method: "GET",
      headers: {
        Authorization: `${config.authScheme ?? "Bearer"} ${config.apiKey}`,
      },
    });
  } catch (err) {
    throw new Error(
      `listModels[${config.providerId}]: network error — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    throw new Error(`listModels[${config.providerId}]: HTTP ${response.status} — ${text}`);
  }

  const body = (await response.json()) as OpenAIModelListResponse;
  if (!Array.isArray(body.data)) {
    throw new Error(
      `listModels[${config.providerId}]: unexpected response shape — missing "data" array`,
    );
  }

  return parseModelList(body.data);
}
