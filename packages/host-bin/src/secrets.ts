import type { SecretsAccess } from "@dispatch/kernel";

/**
 * The environment keys extensions may read through `host.secrets`. Nothing
 * else in the environment is reachable:
 * - `INCO_API_KEY` — the Inco provider.
 * - `FELICITY_API_URL` / `FELICITY_API_TOKEN` — the discord-bridge plugin
 *   (the Felicity bot's tailnet-only agent API; the global `discord` skill
 *   reads the same variables through the shell environment).
 */
export const ALLOWED_ENV_SECRETS: readonly string[] = [
  "INCO_API_KEY",
  "FELICITY_API_URL",
  "FELICITY_API_TOKEN",
];

/** Read-only, explicitly allowlisted environment secrets. Never expose arbitrary env keys. */
export function createEnvSecrets(env: Readonly<Record<string, string | undefined>>): SecretsAccess {
  const values = new Map<string, string>();
  for (const key of ALLOWED_ENV_SECRETS) {
    const value = env[key];
    if (value?.trim()) values.set(key, value);
  }
  return {
    get: async (key) => values.get(key) ?? null,
    set: async () => {
      throw new Error("secrets store not configured");
    },
    delete: async () => {
      throw new Error("secrets store not configured");
    },
  };
}
