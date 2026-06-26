import type { Extension, Manifest } from "@dispatch/kernel";
import type { Credential } from "./registry.js";
import { createCredentialStore } from "./registry.js";
import { credentialStoreHandle } from "./service.js";

export const manifest: Manifest = {
  id: "credential-store",
  name: "Credential Store",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  contributes: { services: ["credential-store/registry"] },
};

export function createCredentialStoreExtension(deps: {
  credentials: readonly Credential[];
}): Extension {
  return {
    manifest,
    activate(host) {
      const store = createCredentialStore({
        credentials: deps.credentials,
        getProvider: (id) => host.getProviders().get(id),
      });
      host.provideService(credentialStoreHandle, store);
    },
  };
}
