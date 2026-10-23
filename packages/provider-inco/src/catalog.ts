import type { ModelInfo } from "@dispatch/kernel";

export interface IncoModelInfo extends ModelInfo {
  /** Kept locally: the kernel ModelInfo ABI has no reasoning capability field. */
  readonly reasoningEffort?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** No inferred vision from names, no invented video capability, no :fast normalization. */
export function parseIncoModels(value: unknown): readonly IncoModelInfo[] {
  const data = record(value)?.data;
  if (!Array.isArray(data))
    throw new Error("inco: malformed models response (expected data array)");
  const models: IncoModelInfo[] = [];
  for (const entry of data) {
    const row = record(entry);
    if (!row || typeof row.id !== "string" || !row.id.trim()) continue;
    const input = record(row.modalities)?.input;
    const reasoning = record(row.capabilities)?.reasoning_effort;
    models.push({
      id: row.id,
      ...(typeof row.name === "string" && row.name.trim() ? { displayName: row.name } : {}),
      ...(typeof row.context_length === "number" &&
      Number.isSafeInteger(row.context_length) &&
      row.context_length > 0
        ? { contextWindow: row.context_length }
        : {}),
      ...(Array.isArray(input) && input.every((part) => typeof part === "string")
        ? { vision: input.includes("image") }
        : {}),
      ...(typeof reasoning === "boolean" ? { reasoningEffort: reasoning } : {}),
    });
  }
  return models;
}
