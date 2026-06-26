import { describe, expect, it } from "vitest";
import { splitNdjsonLines } from "./ndjson.js";

describe("splitNdjsonLines", () => {
  it("splits complete lines", () => {
    const result = splitNdjsonLines('{"a":1}\n{"b":2}\n');
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.rest).toBe("");
  });

  it("keeps incomplete trailing line in rest", () => {
    const result = splitNdjsonLines('{"a":1}\n{"b":2');
    expect(result.lines).toEqual(['{"a":1}']);
    expect(result.rest).toBe('{"b":2');
  });

  it("returns empty lines array for single incomplete line", () => {
    const result = splitNdjsonLines('{"a":1');
    expect(result.lines).toEqual([]);
    expect(result.rest).toBe('{"a":1');
  });

  it("filters out empty lines", () => {
    const result = splitNdjsonLines('{"a":1}\n\n{"b":2}\n');
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.rest).toBe("");
  });

  it("handles a line split across two buffers", () => {
    const buf1 = '{"a":1}\n{"b":';
    const buf2 = '2}\n{"c":3}\n';

    const r1 = splitNdjsonLines(buf1);
    expect(r1.lines).toEqual(['{"a":1}']);
    expect(r1.rest).toBe('{"b":');

    const combined = r1.rest + buf2;
    const r2 = splitNdjsonLines(combined);
    expect(r2.lines).toEqual(['{"b":2}', '{"c":3}']);
    expect(r2.rest).toBe("");
  });

  it("handles empty buffer", () => {
    const result = splitNdjsonLines("");
    expect(result.lines).toEqual([]);
    expect(result.rest).toBe("");
  });
});
