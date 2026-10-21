/**
 * Exact JSON UTF-8 size for transport JSON-domain values, stopping at budget.
 * No serialized copy is allocated. A string's UTF-16 length is a cheap lower
 * bound, so clearly huge tool payloads are rejected without scanning/copying.
 * Plain objects/arrays only; custom serialization and cycles are not wire data.
 */
export function jsonByteBound(value: unknown, budget: number): number | undefined {
  let remaining = budget;
  const ancestors = new Set<object>();
  const take = (bytes: number) => {
    remaining -= bytes;
    return remaining >= 0;
  };
  const string = (text: string): boolean => {
    if (text.length + 2 > remaining || !take(2)) return false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let bytes: number;
      if (code === 34 || code === 92) bytes = 2;
      else if (code < 32) bytes = [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      else if (code < 0x80) bytes = 1;
      else if (code < 0x800) bytes = 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes = 4;
          i++;
        } else bytes = 6; // JSON.stringify escapes lone surrogates.
      } else if (code >= 0xdc00 && code <= 0xdfff) bytes = 6;
      else bytes = 3;
      if (!take(bytes)) return false;
    }
    return true;
  };
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 512) return false;
    if (item === null || item === undefined) return take(4);
    switch (typeof item) {
      case "string":
        return string(item);
      case "number":
        return take(Number.isFinite(item) ? String(item).length : 4);
      case "boolean":
        return take(item ? 4 : 5);
      case "object": {
        if (ancestors.has(item) || "toJSON" in item || !take(2)) return false;
        ancestors.add(item);
        let separator = false;
        if (Array.isArray(item)) {
          for (const entry of item) {
            if ((separator && !take(1)) || !visit(entry, depth + 1)) return false;
            separator = true;
          }
        } else {
          const prototype = Object.getPrototypeOf(item);
          if (prototype !== Object.prototype && prototype !== null) return false;
          for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            const entry = Reflect.get(item, key);
            if (entry === undefined) continue; // Absent JSON object property.
            if ((separator && !take(1)) || !string(key) || !take(1) || !visit(entry, depth + 1))
              return false;
            separator = true;
          }
        }
        ancestors.delete(item);
        return true;
      }
      default:
        return false;
    }
  };
  return visit(value, 0) ? budget - remaining : undefined;
}

/** Serialize once, only after the exact preflight fits. Check actual wire bytes. */
export function serializeWithinBudget(value: unknown, budget: number): string | undefined {
  if (jsonByteBound(value, budget) === undefined) return undefined;
  const serialized = JSON.stringify(value);
  return serialized !== undefined && Buffer.byteLength(serialized) <= budget
    ? serialized
    : undefined;
}
