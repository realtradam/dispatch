import type { SecretsAccess } from "@dispatch/kernel";

/** Read-only, explicitly allowlisted environment secrets. Never expose arbitrary env keys. */
export function createEnvSecrets(env: Readonly<Record<string, string | undefined>>): SecretsAccess {
  const incoKey = env.INCO_API_KEY?.trim() ? env.INCO_API_KEY : null;
  return {
    get: async (key) => (key === "INCO_API_KEY" ? incoKey : null),
    set: async () => {
      throw new Error("secrets store not configured");
    },
    delete: async () => {
      throw new Error("secrets store not configured");
    },
  };
}
