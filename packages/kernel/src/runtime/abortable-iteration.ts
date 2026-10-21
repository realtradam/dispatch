/**
 * Abortable async-iterator wrapping — a generic kernel runtime utility.
 *
 * Wraps an `AsyncIterator` so each `next()` is raced against an `AbortSignal`.
 * If the signal fires while `next()` is pending, the wrapper resolves the
 * iteration as done immediately — without waiting for the upstream provider's
 * `next()` to settle. This bounds active-turn provider consumption: even a
 * provider whose `next()` never settles (or that ignores `opts.signal`) cannot
 * keep `runTurn()` pending after Stop.
 *
 * This is the consumer-side counterpart to the provider contract's `signal`
 * field (see `ProviderStreamOptions.signal`). Provider compliance alone is not
 * sufficient, so every active-turn consumer of a provider iterator should wrap
 * it with this utility.
 *
 * Pure promise coordination + `AbortSignal` listeners only — NO I/O. It mirrors
 * the hanging-tool defense in `dispatch.ts` (`executeToolCall`'s `Promise.race`
 * against an abort listener) extended to repeated `next()` calls plus best-effort
 * `iterator.return()`.
 *
 * Listener hygiene: the wrapper registers exactly ONE abort listener for the
 * lifetime of the iteration (created lazily on the first `next()`), and removes
 * it when `return()` is called. No per-`next()` listener leak on normal
 * completion.
 */

/**
 * Wrap an async iterator so that each `next()` is raced against the abort signal.
 *
 * If the signal fires while `next()` is pending, the wrapper resolves the
 * iteration as done immediately (without waiting for the provider's `next()` to
 * settle). Late rejections from the abandoned `next()` are swallowed.
 * `iterator.return()` is called best-effort once (never awaited if it hangs).
 */
export function abortableIteration<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): AsyncIterableIterator<T> {
  // Identity distinguishes an abort-gate win from natural upstream completion.
  const abortedResult: IteratorResult<T> = { done: true, value: undefined };
  let returned = false;
  let gate: Promise<IteratorResult<T>> | undefined;
  let removeListener: (() => void) | undefined;

  /**
   * A single abort gate: a promise that resolves `{done:true}` when the signal
   * fires, plus a listener that removes ITSELF once the gate settles. Created
   * lazily so an iteration that never calls `next()` registers nothing.
   */
  const ensureGate = (): Promise<IteratorResult<T>> => {
    if (gate) return gate;
    gate = new Promise<IteratorResult<T>>((resolve) => {
      const onAbort = (): void => resolve(abortedResult);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeListener = () => signal.removeEventListener("abort", onAbort);
    });
    return gate;
  };

  const invokeReturn = (): Promise<IteratorResult<T>> => {
    if (returned) return Promise.resolve({ done: true, value: undefined });
    returned = true;
    const returnFn = iterator.return;
    if (!returnFn) return Promise.resolve({ done: true, value: undefined });
    try {
      const p = returnFn.call(iterator);
      // Never block settlement on a hanging/rejecting return(); always swallow.
      void p.catch(() => {});
    } catch {
      /* swallow */
    }
    return Promise.resolve({ done: true, value: undefined });
  };

  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
      return this as AsyncIterableIterator<T>;
    },
    next: () => {
      if (signal.aborted) {
        // Iteration already ended via abort. Make sure the listener (if any
        // gate was opened) is detached.
        removeListener?.();
        removeListener = undefined;
        return invokeReturn();
      }
      const nextPromise = iterator.next();
      // Swallow late rejections from the abandoned `next()`: it may reject after
      // the race already resolved as done via abort.
      void nextPromise.catch(() => {});
      return Promise.race([nextPromise, ensureGate()]).then((result) => {
        if (result === abortedResult) void invokeReturn();
        // On natural or abort-driven completion, detach the gate listener so a
        // completed (non-aborted) iteration leaves nothing behind. `for await`
        // does NOT call return() on normal completion, so this is the single
        // cleanup point for the "stream ended by itself" path.
        if (result.done) {
          removeListener?.();
          removeListener = undefined;
        }
        return result;
      });
    },
    return: () => {
      // Detach the abort gate listener so a completed (non-aborted) iteration
      // leaves nothing behind.
      removeListener?.();
      removeListener = undefined;
      return invokeReturn();
    },
    throw: (err) => {
      removeListener?.();
      removeListener = undefined;
      const throwFn = (
        iterator as AsyncIterator<T> & { throw?: (e: unknown) => Promise<IteratorResult<T>> }
      ).throw;
      if (throwFn) {
        try {
          const p = throwFn.call(iterator, err);
          void p.catch(() => {});
        } catch {
          /* swallow */
        }
      }
      return Promise.resolve({ done: true, value: undefined });
    },
  };
}
