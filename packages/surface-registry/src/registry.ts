import type { SurfaceCatalog, SurfaceCatalogEntry, SurfaceSpec } from "@dispatch/ui-contract";

/**
 * Optional context threaded by the transport when calling a surface provider.
 * Providers may use this to scope per-conversation state; omitting it yields
 * the default/global behaviour.
 */
export interface SurfaceContext {
  readonly conversationId?: string;
}

/**
 * What a surface-contributing extension registers with the surface registry.
 * Each provider owns one surface identified by its catalog entry id.
 */
export interface SurfaceProvider {
  /** Discovery metadata for the surface catalog. */
  readonly catalogEntry: SurfaceCatalogEntry;

  /** Build the current surface spec (may be async for dynamic surfaces). */
  getSpec(context?: SurfaceContext): SurfaceSpec | Promise<SurfaceSpec>;

  /** Run a backend action by id with an optional payload. */
  invoke(actionId: string, payload?: unknown, context?: SurfaceContext): void | Promise<void>;

  /**
   * Optional: subscribe to spec changes. Returns an unsubscribe disposer.
   * When the spec changes, the caller should re-fetch via getSpec() and push.
   */
  subscribe?(onChange: () => void): () => void;
}

/**
 * The surface registry service — the interface other extensions obtain via
 * `host.getService(surfaceRegistryHandle)`.
 */
export interface SurfaceRegistry {
  /**
   * Register a surface provider. Returns an unregister disposer.
   * If a provider with the same id is already registered, the new one
   * replaces it (last-wins semantics).
   */
  register(provider: SurfaceProvider): () => void;

  /** Return discovery metadata for all currently registered providers. */
  getCatalog(): SurfaceCatalog;

  /** Look up a provider by its surface id. */
  getSurface(id: string): SurfaceProvider | undefined;
}

/**
 * Create a pure in-memory surface registry. No I/O, no ambient state —
 * the decision logic is a plain Map behind the SurfaceRegistry interface.
 */
export function createSurfaceRegistry(): SurfaceRegistry {
  const providers = new Map<string, SurfaceProvider>();

  return {
    register(provider: SurfaceProvider): () => void {
      const id = provider.catalogEntry.id;
      providers.set(id, provider);

      let disposed = false;
      return () => {
        if (!disposed) {
          disposed = true;
          // Only delete if the current entry is still this provider
          // (another register with the same id may have replaced it).
          if (providers.get(id) === provider) {
            providers.delete(id);
          }
        }
      };
    },

    getCatalog(): SurfaceCatalog {
      const entries: SurfaceCatalogEntry[] = [];
      for (const provider of providers.values()) {
        entries.push(provider.catalogEntry);
      }
      return entries;
    },

    getSurface(id: string): SurfaceProvider | undefined {
      return providers.get(id);
    },
  };
}
