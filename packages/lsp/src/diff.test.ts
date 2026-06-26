import { describe, expect, it } from "vitest";
import { computeChangeRange, offsetToPosition } from "./diff.js";

describe("offsetToPosition", () => {
  it("returns 0:0 for offset 0", () => {
    expect(offsetToPosition("hello", 0)).toEqual({ line: 0, character: 0 });
  });

  it("counts characters on the first line", () => {
    expect(offsetToPosition("hello", 3)).toEqual({ line: 0, character: 3 });
  });

  it("resets character count after newline", () => {
    expect(offsetToPosition("ab\ncd", 4)).toEqual({ line: 1, character: 1 });
  });

  it("handles multiple lines", () => {
    expect(offsetToPosition("a\nb\nc", 4)).toEqual({ line: 2, character: 0 });
  });

  it("clamps offset beyond text length", () => {
    expect(offsetToPosition("ab", 100)).toEqual({ line: 0, character: 2 });
  });

  it("handles empty string", () => {
    expect(offsetToPosition("", 0)).toEqual({ line: 0, character: 0 });
  });
});

describe("computeChangeRange", () => {
  it("detects a single-line insertion", () => {
    const oldText = "hello world";
    const newText = "hello cruel world";
    const change = computeChangeRange(oldText, newText);
    expect(change.range.start).toEqual({ line: 0, character: 6 });
    expect(change.range.end).toEqual({ line: 0, character: 6 });
    expect(change.text).toBe("cruel ");
  });

  it("detects a single-line deletion", () => {
    const oldText = "hello cruel world";
    const newText = "hello world";
    const change = computeChangeRange(oldText, newText);
    expect(change.range.start).toEqual({ line: 0, character: 6 });
    expect(change.range.end).toEqual({ line: 0, character: 12 });
    expect(change.text).toBe("");
  });

  it("detects a single-line replacement", () => {
    const oldText = "hello world";
    const newText = "hello earth";
    const change = computeChangeRange(oldText, newText);
    expect(change.range.start).toEqual({ line: 0, character: 6 });
    expect(change.range.end).toEqual({ line: 0, character: 11 });
    expect(change.text).toBe("earth");
  });

  it("handles multi-line changes with correct line positions", () => {
    const oldText = "line1\nline2\nline3";
    const newText = "line1\nCHANGED\nline3";
    const change = computeChangeRange(oldText, newText);
    // Common prefix: "line1\n" → start at beginning of line 1
    expect(change.range.start).toEqual({ line: 1, character: 0 });
    // Common suffix: "\nline3" → end after "line2" on line 1
    expect(change.range.end).toEqual({ line: 1, character: 5 });
    expect(change.text).toBe("CHANGED");
  });

  it("handles insertion at end of file", () => {
    const oldText = "abc";
    const newText = "abcdef";
    const change = computeChangeRange(oldText, newText);
    expect(change.range.start).toEqual({ line: 0, character: 3 });
    expect(change.range.end).toEqual({ line: 0, character: 3 });
    expect(change.text).toBe("def");
  });

  it("handles complete file replacement (no common prefix/suffix)", () => {
    const oldText = "abc";
    const newText = "xyz";
    const change = computeChangeRange(oldText, newText);
    expect(change.range.start).toEqual({ line: 0, character: 0 });
    expect(change.range.end).toEqual({ line: 0, character: 3 });
    expect(change.text).toBe("xyz");
  });

  it("handles empty old text (new file)", () => {
    const oldText = "";
    const newText = "hello\nworld";
    const change = computeChangeRange(oldText, newText);
    expect(change.range.start).toEqual({ line: 0, character: 0 });
    expect(change.range.end).toEqual({ line: 0, character: 0 });
    expect(change.text).toBe("hello\nworld");
  });

  it("handles identical text (no change)", () => {
    const oldText = "same text";
    const newText = "same text";
    const change = computeChangeRange(oldText, newText);
    expect(change.range.start).toEqual({ line: 0, character: 9 });
    expect(change.range.end).toEqual({ line: 0, character: 9 });
    expect(change.text).toBe("");
  });

  it("handles change spanning multiple lines", () => {
    const oldText = "function foo() {\n  return 1;\n}\n";
    const newText = "function foo() {\n  return 2;\n  console.log('hi');\n}\n";
    const change = computeChangeRange(oldText, newText);
    // Common prefix: "function foo() {\n  return " (26 chars)
    // The change starts at "1" on line 1, character 9
    expect(change.range.start).toEqual({ line: 1, character: 9 });
    // Common suffix: ";\n}\n" (4 chars) → end at offset 27 (the ";")
    // offset 27 = line 1, char 10 (after "  return 1")
    expect(change.range.end).toEqual({ line: 1, character: 10 });
    expect(change.text).toBe("2;\n  console.log('hi')");
  });
});
