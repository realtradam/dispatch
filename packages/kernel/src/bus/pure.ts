import type { Logger } from "../contracts/extension.js";
import type { EventHandler, FilterHandler } from "../contracts/hooks.js";

export function dispatchEventSync<T>(
  handlers: ReadonlyArray<EventHandler<T>>,
  payload: T,
  logger: Logger,
  hookId: string,
): void {
  for (const handler of handlers) {
    try {
      const result = handler(payload);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          logger.error(`Event hook "${hookId}" handler rejected`, { err });
        });
      }
    } catch (err) {
      logger.error(`Event hook "${hookId}" handler threw`, { err });
    }
  }
}

export async function dispatchEventAsync<T>(
  handlers: ReadonlyArray<EventHandler<T>>,
  payload: T,
  logger: Logger,
  hookId: string,
  timeoutMs?: number,
): Promise<void> {
  const promises = handlers.map(async (handler) => {
    try {
      await handler(payload);
    } catch (err) {
      logger.error(`Event hook "${hookId}" handler threw`, { err });
    }
  });

  if (timeoutMs !== undefined) {
    await Promise.race([
      Promise.all(promises),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  } else {
    await Promise.all(promises);
  }
}

export interface FilterEntry<T> {
  readonly fn: FilterHandler<T>;
  readonly priority: number;
  readonly order: number;
}

export function sortFilters<T>(
  entries: ReadonlyArray<FilterEntry<T>>,
): ReadonlyArray<FilterEntry<T>> {
  return [...entries].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.order - b.order;
  });
}

export async function applyFilterChain<T>(
  filters: ReadonlyArray<FilterHandler<T>>,
  value: T,
  logger: Logger,
  hookId: string,
  failClosed: boolean,
): Promise<T> {
  let current = value;
  for (const fn of filters) {
    try {
      current = await fn(current);
    } catch (err) {
      if (failClosed) throw err;
      logger.error(`Filter "${hookId}" handler threw (fail-open, passing through)`, { err });
    }
  }
  return current;
}
