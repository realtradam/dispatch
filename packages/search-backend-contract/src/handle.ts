import { defineService, type ServiceHandle } from "@dispatch/kernel";
import type { SearchBackend } from "./index.js";

/** The registry every search backend registers into. */
export interface SearchBackendRegistry {
  /**
   * Register a backend under its `id`. Returns an idempotent disposer that
   * removes exactly this registration. Throws if the id is already registered.
   */
  readonly register: (backend: SearchBackend) => () => void;
}

export const searchBackendRegistryHandle: ServiceHandle<SearchBackendRegistry> =
  defineService<SearchBackendRegistry>("search/backend-registry");
