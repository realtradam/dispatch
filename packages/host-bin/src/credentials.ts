import type { Credential } from "@dispatch/credential-store";

/** Match the read-only secret adapter: blank keys never create selectable credentials. */
export function createIncoCredentials(
  env: Readonly<Record<string, string | undefined>>,
): readonly Credential[] {
  return env.INCO_API_KEY?.trim() ? [{ name: "inco", providerId: "inco" }] : [];
}
