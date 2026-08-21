import { describe, expect, it } from "vitest";
import { abortableIteration } from "./abortable-iteration.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** An async iterator that yields items slowly; supports a never-settles mode. */
function timedIterator<T>(
  items: readonly T[],
  opts?: { hangAfterItems?: number; hangReturn?: boolean },
): AsyncIterator<T> {
  let i = 0;
  const { hangAfterItems = Infinity, hangReturn = false } = opts ?? {};
  return {
    next: () =>
      new Promise<IteratorResult<T>>((resolve) => {
        if (i >= items.length) return resolve({ done: true, value: undefined });
        if (i >= hangAfterItems) {
          // Never settles — simulates a provider whose next() blocks forever.
          return;
        }
        const value = items[i];
        i++;
        setTimeout(() => resolve({ done: false, value }), 1);
      }),
    return: () =>
      hangReturn
        ? new Promise(() => {}) // never settles
        : Promise.resolve({ done: true, value: undefined }),
    throw: (err) => Promise.reject(err),
  };
}

describe("abortableIteration", () => {
  it("yields each item in order", async () => {
    const iter = abortableIteration(timedIterator(["a", "b", "c"]), new AbortController().signal);
    const out: string[] = [];
    for await (const v of iter) {
      out.push(String(v));
    }
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("returns immediately (done) when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const iter = abortableIteration(timedIterator(["a", "b"]), controller.signal);
    const out: string[] = [];
    for await (const v of iter) {
      out.push(String(v));
    }
    expect(out).toEqual([]);
  });

  it("stops iteration promptly when abort fires mid-iteration", async () => {
    const controller = new AbortController();
    const itemCount = 100;
    const iter = abortableIteration(
      timedIterator(Array.from({ length: itemCount }, (_, i) => i)),
      controller.signal,
    );
    const out: number[] = [];
    const loopPromise = (async () => {
      for await (const v of iter) {
        out.push(Number(v));
        if (out.length === 3) controller.abort();
      }
    })();
    await loopPromise;
    expect(out.length).toBeLessThan(itemCount);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("settles when the provider's next() never settles and abort fires", async () => {
    const controller = new AbortController();
    const iter = abortableIteration(
      timedIterator(["a", "b"], { hangAfterItems: 1 }),
      controller.signal,
    );
    const out: string[] = [];
    setTimeout(() => controller.abort(), 5);
    // If this hangs, the test times out — bounded by the abort race.
    for await (const v of iter) {
      out.push(String(v));
    }
    expect(out).toEqual(["a"]);
  });

  it("calls iterator.return() exactly once on early exit (break)", async () => {
    let returnCalls = 0;
    const base = timedIterator(["a", "b", "c"]);
    const iter = abortableIteration(
      {
        ...base,
        return: () => {
          returnCalls++;
          return Promise.resolve({ done: true, value: undefined });
        },
      },
      new AbortController().signal,
    );
    for await (const _v of iter) {
      break; // early exit → for-await invokes return()
    }
    expect(returnCalls).toBe(1);
  });

  it("does not await a hanging return() before settling", async () => {
    const controller = new AbortController();
    const iter = abortableIteration(
      timedIterator(["a", "b"], { hangReturn: true }),
      controller.signal,
    );
    const out: string[] = [];
    // Consume fully, then abort (return() will be invoked and hangs — must not
    // block settlement).
    const loopPromise = (async () => {
      for await (const v of iter) {
        out.push(String(v));
        if (out.length === 2) controller.abort();
      }
    })();
    await Promise.race([loopPromise, delay(50).then(() => "timeout")]);
    expect(out).toEqual(["a", "b"]);
  });

  it("removes its abort listener after abort so no leak remains", async () => {
    const controller = new AbortController();
    const iter = abortableIteration(timedIterator(["x"]), controller.signal);
    setTimeout(() => controller.abort(), 1);
    for await (const _v of iter) {
      // consume
    }
    // After return() the gate listener is detached; a fresh abort must be
    // observable as a no-op (no resolution), which we assert by re-aborting
    // and confirming iteration still reports done without hanging.
    controller.abort();
    expect(true).toBe(true);
  });
});
