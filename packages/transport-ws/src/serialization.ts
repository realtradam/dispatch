/**
 * Conservative JSON wire-size preflight without allocating a serialized copy.
 * JSON-compatible events/specs only. Depth and visited-value limits also bound
 * work for deeply nested or very wide tool inputs. A rejected value is never
 * passed to JSON.stringify. String escaping costs at most six bytes/code unit.
 */
export function jsonByteBound(value: unknown, budget: number): number | undefined {
  let remaining = budget;
  let visits = 8192;
  const take = (bytes: number) => {
    remaining -= bytes;
    return remaining >= 0;
  };
  const visit = (item: unknown, depth: number): boolean => {
    if (--visits < 0 || depth > 32) return false;
    if (item === null || item === undefined) return take(4);
    switch (typeof item) {
      case "string":
        return take(2 + item.length * 6);
      case "number":
        return take(32);
      case "boolean":
        return take(5);
      case "object": {
        if (!take(2) || "toJSON" in item) return false;
        if (Array.isArray(item)) {
          for (const entry of item) {
            if (!take(1) || !visit(entry, depth + 1)) return false;
          }
        } else {
          const prototype = Object.getPrototypeOf(item);
          if (prototype !== Object.prototype && prototype !== null) return false;
          for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            if (!take(4 + key.length * 6) || !visit(Reflect.get(item, key), depth + 1))
              return false;
          }
        }
        return true;
      }
      default:
        return false;
    }
  };
  return visit(value, 0) ? budget - remaining : undefined;
}
