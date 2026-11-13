/**
 * The search-backend registry implementation — state is owned by the
 * instance (no module-level state). The extension creates one, provides
 * `registry` as the `search/backend-registry` service, and wires `list` into
 * the search-config service.
 */

import type { SearchBackend, SearchBackendRegistry } from "@dispatch/search-backend-contract";

export interface SearchBackendRegistryInstance {
  /** What is provided as the `search/backend-registry` service. */
  readonly registry: SearchBackendRegistry;
  /** The registered backends in registration order. */
  readonly list: () => readonly SearchBackend[];
}

export function createSearchBackendRegistry(): SearchBackendRegistryInstance {
  const entries: SearchBackend[] = [];

  const registry: SearchBackendRegistry = {
    register(backend: SearchBackend): () => void {
      if (entries.some((entry) => entry.id === backend.id)) {
        throw new Error(`Search backend "${backend.id}" is already registered.`);
      }
      entries.push(backend);
      let disposed = false;
      return () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const index = entries.indexOf(backend);
        if (index !== -1) {
          entries.splice(index, 1);
        }
      };
    },
  };

  return {
    registry,
    list: () => [...entries],
  };
}
