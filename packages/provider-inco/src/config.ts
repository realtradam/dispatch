import type { ReasoningEffort } from "@dispatch/kernel";

export const INCO_BASE_URL = "https://api.inco.ai/v1";
export const INCO_DEFAULT_MODEL = "glm-5.3-flash:fast";

/** Values are supplied by the host; this resolver never reads ambient environment/secrets. */
export interface IncoConfigInput {
  readonly apiKey?: string | null;
  readonly baseURL?: string | null;
  readonly model?: string | null;
  readonly envBaseURL?: string | null;
  readonly envModel?: string | null;
}

export interface ResolvedIncoConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
}

export function resolveIncoConfig(input: IncoConfigInput): ResolvedIncoConfig | undefined {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseURL: (input.baseURL?.trim() || input.envBaseURL?.trim() || INCO_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    model: input.model?.trim() || input.envModel?.trim() || INCO_DEFAULT_MODEL,
  };
}

/**
 * Inco rejects maker-unsupported levels (platform.inco.ai/docs#reasoning).
 * Z.ai documents GLM-5.3 low/high/max, NOT medium or xhigh:
 * https://docs.z.ai/guides/llm/glm-5.3 . The Flash variant is independently
 * verified to accept low. Use conservative low/high only for this family;
 * unknown makers retain their native default rather than guessing a vocabulary.
 * An explicit live-catalog capability denial always wins.
 */
export function mapIncoReasoningEffort(
  model: string,
  effort: ReasoningEffort | undefined,
  supported?: boolean,
): "low" | "high" | undefined {
  if (supported === false || effort === undefined) return undefined;
  if (!/^glm-5\.3(?:-flash)?(?::fast)?$/.test(model)) return undefined;
  return effort === "low" || effort === "medium" ? "low" : "high";
}
