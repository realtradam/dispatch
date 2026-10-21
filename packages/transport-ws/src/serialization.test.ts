import { expect, it } from "vitest";
import { jsonByteBound } from "./serialization.js";

it("bounds UTF-8 and JSON escapes before serialization, including undefined fields", () => {
  for (const value of [
    null,
    true,
    false,
    1e300,
    -1e-300,
    "\u0000😀é",
    { a: [1, "x", undefined], absent: undefined },
  ]) {
    const bound = jsonByteBound(value, 256 * 1024);
    expect(bound).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(value)));
    expect(jsonByteBound(value, (bound ?? 0) - 1)).toBeUndefined();
  }
});

it("rejects huge strings, wide/deep inputs and cycles without stringifying them", () => {
  expect(jsonByteBound({ input: "x".repeat(9 * 1024 * 1024) }, 256 * 1024)).toBeUndefined();
  expect(jsonByteBound(Array(9000).fill(null), 256 * 1024)).toBeUndefined();
  let nested: unknown = {};
  for (let i = 0; i < 40; i++) nested = { nested };
  expect(jsonByteBound(nested, 256 * 1024)).toBeUndefined();
  const withHook = {};
  Object.defineProperty(withHook, "toJSON", { value: () => "x".repeat(9 * 1024 * 1024) });
  expect(jsonByteBound(withHook, 256 * 1024)).toBeUndefined();
  const cycle: { cycle?: unknown } = {};
  cycle.cycle = cycle;
  expect(jsonByteBound(cycle, 256 * 1024)).toBeUndefined();
});
