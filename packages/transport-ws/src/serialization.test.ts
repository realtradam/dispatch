import { expect, it } from "vitest";
import { jsonByteBound, serializeWithinBudget } from "./serialization.js";

it("counts exact UTF-8 JSON bytes, including escaping and omitted undefined fields", () => {
  for (const value of [
    null,
    true,
    false,
    1e300,
    -1e-300,
    '\u0000😀é\ud800\udc00\ud800\udfff\n\t\b\f\r\\"',
    [NaN, Infinity, -Infinity, -0, ...Array(1), undefined],
    { 'é😀"': 0, nested: { a: null } },
    { a: [1, "x", undefined], absent: undefined },
  ]) {
    const bound = jsonByteBound(value, 256 * 1024);
    expect(bound).toBe(Buffer.byteLength(JSON.stringify(value)));
    expect(jsonByteBound(value, (bound ?? 0) - 1)).toBeUndefined();
  }
});

it("rejects huge strings, pathological nesting, custom serialization and cycles", () => {
  expect(jsonByteBound({ input: "x".repeat(9 * 1024 * 1024) }, 256 * 1024)).toBeUndefined();
  expect(jsonByteBound(Array(9000).fill(null), 256 * 1024)).toBe(45001);
  let nested: unknown = {};
  for (let i = 0; i < 600; i++) nested = { nested };
  expect(jsonByteBound(nested, 256 * 1024)).toBeUndefined();
  const withHook = {};
  Object.defineProperty(withHook, "toJSON", { value: () => "x".repeat(9 * 1024 * 1024) });
  expect(jsonByteBound(withHook, 256 * 1024)).toBeUndefined();
  const cycle: { cycle?: unknown } = {};
  cycle.cycle = cycle;
  expect(jsonByteBound(cycle, 256 * 1024)).toBeUndefined();
});

it("accepts exact byte boundaries and serializes ordinary MiB-scale payloads in full", () => {
  for (const text of ["x".repeat(1024 * 1024), "é😀\u0000\n".repeat(20_000)]) {
    const value = { content: text, absent: undefined };
    const expected = JSON.stringify(value);
    const bytes = Buffer.byteLength(expected);
    expect(jsonByteBound(value, bytes)).toBe(bytes);
    expect(serializeWithinBudget(value, bytes)).toBe(expected);
    expect(serializeWithinBudget(value, bytes - 1)).toBeUndefined();
  }
});

it("wide ordinary inputs above the old traversal cap are not spuriously rejected", () => {
  const value = Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [`key-${i}`, i]));
  const bytes = Buffer.byteLength(JSON.stringify(value));
  expect(jsonByteBound(value, 4 * 1024 * 1024)).toBe(bytes);
  expect(serializeWithinBudget(value, bytes)).toBe(JSON.stringify(value));
});

it("matches stringify for all UTF-16 code units and the exact 4 MiB chat boundary", () => {
  const text = Array.from({ length: 65_536 }, (_, code) => String.fromCharCode(code)).join("");
  const value = { content: text };
  expect(jsonByteBound(value, 4 * 1024 * 1024)).toBe(Buffer.byteLength(JSON.stringify(value)));
  const empty = { type: "chat.delta", event: { type: "tool-result", content: "" } };
  const overhead = Buffer.byteLength(JSON.stringify(empty));
  const exact = {
    ...empty,
    event: { ...empty.event, content: "x".repeat(4 * 1024 * 1024 - overhead) },
  };
  expect(serializeWithinBudget(exact, 4 * 1024 * 1024)).toBe(JSON.stringify(exact));
  expect(
    serializeWithinBudget(
      { ...exact, event: { ...exact.event, content: `${exact.event.content}x` } },
      4 * 1024 * 1024,
    ),
  ).toBeUndefined();
});
