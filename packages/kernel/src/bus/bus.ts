import type { Logger } from "../contracts/extension.js";
import type {
  EventHandler,
  EventHookDescriptor,
  FilterDescriptor,
  FilterHandler,
  ServiceHandle,
} from "../contracts/hooks.js";
import {
  applyFilterChain,
  dispatchEventAsync,
  dispatchEventSync,
  type FilterEntry,
  sortFilters,
} from "./pure.js";

export interface Bus {
  readonly on: <T>(hook: EventHookDescriptor<T>, handler: EventHandler<T>) => () => void;
  readonly emit: <T>(hook: EventHookDescriptor<T>, payload: T) => void;
  readonly emitAsync: <T>(
    hook: EventHookDescriptor<T>,
    payload: T,
    timeoutMs?: number,
  ) => Promise<void>;
  readonly addFilter: <T>(
    hook: FilterDescriptor<T>,
    fn: FilterHandler<T>,
    opts?: { readonly priority?: number },
  ) => () => void;
  readonly applyFilters: <T>(
    hook: FilterDescriptor<T>,
    value: T,
    opts?: { readonly failClosed?: boolean },
  ) => Promise<T>;
  /**
   * Provide an implementation for a typed service handle. Returns an
   * un-provide disposer: calling it removes the implementation so a later
   * `getService` for the handle throws again. Idempotent — a disposer for an
   * already-removed (or replaced) handle is a no-op. Notifies
   * `onServiceAvailable` subscribers on provide and `onServiceUnavailable`
   * subscribers on un-provide.
   */
  readonly provideService: <T>(handle: ServiceHandle<T>, impl: T) => () => void;
  readonly getService: <T>(handle: ServiceHandle<T>) => T;

  // ── Reactive service registry (plan 03) ────────────────────────────────────
  /**
   * Non-throwing service lookup: returns the current implementation for the
   * handle, or `undefined` when nothing provided it. Never throws — the
   * consumption pattern for OPTIONAL services (a Core extension consuming a
   * Standard-provided service degrades when it is absent). `getService`
   * keeps its throwing behavior for genuine mandatory (core→core) deps.
   */
  readonly tryGetService: <T>(handle: ServiceHandle<T>) => T | undefined;
  /**
   * Subscribe to a service becoming available. Fires IMMEDIATELY (synchronously)
   * with the current implementation when the service is already provided, then
   * once per subsequent `provideService` for the handle. Returns a disposer.
   * Callbacks are error-isolated: a thrown callback is logged, never breaks
   * the provider (mirrors event-hook semantics).
   */
  readonly onServiceAvailable: <T>(handle: ServiceHandle<T>, cb: (impl: T) => void) => () => void;
  /**
   * Subscribe to a service becoming unavailable: fires when the service's
   * un-provide disposer actually removes it (a stale disposer that fails to
   * evict a newer registration does NOT fire). Returns a disposer. Callbacks
   * are error-isolated (thrown callback is logged, never breaks the provider).
   */
  readonly onServiceUnavailable: <T>(handle: ServiceHandle<T>, cb: () => void) => () => void;
}

interface StoredFilterEntry {
  readonly fn: unknown;
  readonly priority: number;
  readonly order: number;
}

/** The optional sorter is injected so cache behavior can be measured without internal mocks. */
export function createBus(logger: Logger, sort: typeof sortFilters = sortFilters): Bus {
  const eventHandlers = new Map<string, Set<unknown>>();
  const filterEntries = new Map<string, StoredFilterEntry[]>();
  const sortedFilters = new Map<string, readonly unknown[]>();
  const services = new Map<string, unknown>();
  // Reactive-registry subscriber sets, keyed by service-handle id. Available
  // callbacks receive the implementation; unavailable callbacks take none.
  const serviceAvailableSubs = new Map<string, Set<unknown>>();
  const serviceUnavailableSubs = new Map<string, Set<() => void>>();
  let filterOrderCounter = 0;

  /**
   * Notify availability subscribers — error-isolated per callback (a thrown
   * callback is logged, never breaks the provider; mirrors event-hook
   * dispatch). Iterates a snapshot so a callback that (un)subscribes during
   * notification cannot corrupt the iteration.
   */
  function notifyServiceAvailable(id: string, impl: unknown): void {
    const set = serviceAvailableSubs.get(id);
    if (set === undefined || set.size === 0) return;
    const cbs = [...set] as Array<(impl: unknown) => void>;
    for (const cb of cbs) {
      try {
        cb(impl);
      } catch (err) {
        logger.error(`Service "${id}" availability callback threw`, { err });
      }
    }
  }

  /** Notify unavailability subscribers — same isolation as above. */
  function notifyServiceUnavailable(id: string): void {
    const set = serviceUnavailableSubs.get(id);
    if (set === undefined || set.size === 0) return;
    const cbs = [...set];
    for (const cb of cbs) {
      try {
        cb();
      } catch (err) {
        logger.error(`Service "${id}" unavailability callback threw`, { err });
      }
    }
  }

  return {
    on<T>(hook: EventHookDescriptor<T>, handler: EventHandler<T>): () => void {
      let set = eventHandlers.get(hook.id);
      if (set === undefined) {
        set = new Set();
        eventHandlers.set(hook.id, set);
      }
      const stored: unknown = handler;
      set.add(stored);
      return () => {
        const current = eventHandlers.get(hook.id);
        if (current !== undefined) current.delete(stored);
      };
    },

    emit<T>(hook: EventHookDescriptor<T>, payload: T): void {
      const set = eventHandlers.get(hook.id);
      if (set === undefined || set.size === 0) return;
      const handlers = [...set] as Array<EventHandler<T>>;
      dispatchEventSync(handlers, payload, logger, hook.id);
    },

    async emitAsync<T>(
      hook: EventHookDescriptor<T>,
      payload: T,
      timeoutMs?: number,
    ): Promise<void> {
      const set = eventHandlers.get(hook.id);
      if (set === undefined || set.size === 0) return;
      const handlers = [...set] as Array<EventHandler<T>>;
      await dispatchEventAsync(handlers, payload, logger, hook.id, timeoutMs);
    },

    addFilter<T>(
      hook: FilterDescriptor<T>,
      fn: FilterHandler<T>,
      opts?: { readonly priority?: number },
    ): () => void {
      let entries = filterEntries.get(hook.id);
      if (entries === undefined) {
        entries = [];
        filterEntries.set(hook.id, entries);
      }
      const entry: StoredFilterEntry = {
        fn,
        priority: opts?.priority ?? 0,
        order: filterOrderCounter++,
      };
      entries.push(entry);
      sortedFilters.delete(hook.id);
      return () => {
        const current = filterEntries.get(hook.id);
        if (current === undefined) return;
        const idx = current.indexOf(entry);
        if (idx !== -1) {
          current.splice(idx, 1);
          sortedFilters.delete(hook.id);
        }
      };
    },

    async applyFilters<T>(
      hook: FilterDescriptor<T>,
      value: T,
      opts?: { readonly failClosed?: boolean },
    ): Promise<T> {
      const entries = filterEntries.get(hook.id);
      if (entries === undefined || entries.length === 0) return value;
      let fns = sortedFilters.get(hook.id) as readonly FilterHandler<T>[] | undefined;
      if (fns === undefined) {
        fns = sort(entries as ReadonlyArray<FilterEntry<T>>).map((entry) => entry.fn);
        sortedFilters.set(hook.id, fns);
      }
      return applyFilterChain(fns, value, logger, hook.id, opts?.failClosed ?? false);
    },

    provideService<T>(handle: ServiceHandle<T>, impl: T): () => void {
      if (services.has(handle.id)) {
        throw new Error(
          `Service "${handle.id}" is already provided. Only one provider per handle is allowed.`,
        );
      }
      services.set(handle.id, impl);
      notifyServiceAvailable(handle.id, impl);
      return () => {
        // Only remove our own registration: if a provider re-provided the
        // handle after us, the disposer must not evict theirs — and must not
        // announce it unavailable either.
        if (services.get(handle.id) === impl) {
          services.delete(handle.id);
          notifyServiceUnavailable(handle.id);
        }
      };
    },

    getService<T>(handle: ServiceHandle<T>): T {
      const impl = services.get(handle.id);
      if (impl === undefined) {
        throw new Error(
          `Service "${handle.id}" has no provider. Call provideService before getService.`,
        );
      }
      return impl as T;
    },

    tryGetService<T>(handle: ServiceHandle<T>): T | undefined {
      return services.get(handle.id) as T | undefined;
    },

    onServiceAvailable<T>(handle: ServiceHandle<T>, cb: (impl: T) => void): () => void {
      let set = serviceAvailableSubs.get(handle.id);
      if (set === undefined) {
        set = new Set();
        serviceAvailableSubs.set(handle.id, set);
      }
      const stored = cb as (impl: unknown) => void;
      set.add(stored);
      // Fire immediately when the service is already provided — the
      // subscriber sees the current state without waiting for the next
      // provide (late-join semantics).
      const current = services.get(handle.id);
      if (current !== undefined) {
        try {
          stored(current);
        } catch (err) {
          logger.error(`Service "${handle.id}" availability callback threw`, { err });
        }
      }
      return () => {
        const subs = serviceAvailableSubs.get(handle.id);
        if (subs !== undefined) subs.delete(stored);
      };
    },

    onServiceUnavailable<T>(handle: ServiceHandle<T>, cb: () => void): () => void {
      let set = serviceUnavailableSubs.get(handle.id);
      if (set === undefined) {
        set = new Set();
        serviceUnavailableSubs.set(handle.id, set);
      }
      set.add(cb);
      return () => {
        const subs = serviceUnavailableSubs.get(handle.id);
        if (subs !== undefined) subs.delete(cb);
      };
    },
  };
}
