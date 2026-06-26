import type { ApiKeyCredentials } from "@dispatch/kernel";

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";

export function resolveApiKeyCredentials(
  env: Readonly<Record<string, string | undefined>>,
): ApiKeyCredentials {
  const apiKey = env.DISPATCH_API_KEY;
  if (!apiKey) {
    throw new Error("DISPATCH_API_KEY is not set. Set it in your environment or .env file.");
  }
  const baseURL = env.DISPATCH_BASE_URL ?? DEFAULT_BASE_URL;
  return { type: "api-key", apiKey, baseURL };
}
