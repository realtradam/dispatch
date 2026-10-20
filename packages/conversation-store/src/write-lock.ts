/** Pure, instance-owned FIFO promise chains. Reentrancy belongs to the adapter. */
export function createWriteLock(tails = new Map<string, Promise<void>>()) {
  return {
    async runExclusive<T>(id: string, fn: () => T | PromiseLike<T>): Promise<T> {
      const previous = tails.get(id) ?? Promise.resolve();
      let release = () => {};
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(id, tail);
      await previous;
      try {
        return await fn();
      } finally {
        if (tails.get(id) === tail) tails.delete(id);
        release();
      }
    },
  };
}
