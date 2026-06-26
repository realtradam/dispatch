import type { LogRecord } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { formatDuration, renderEasyView } from "./easy-view.js";

describe("renderEasyView", () => {
  it("returns empty string for empty records", () => {
    expect(renderEasyView([])).toBe("");
  });

  it("renders a single span with no children", () => {
    const records: LogRecord[] = [
      {
        kind: "span-open",
        spanId: "s1",
        name: "step",
        timestamp: 1000,
        extensionId: "ext",
        turnId: "t1",
      },
      {
        kind: "span-close",
        spanId: "s1",
        name: "step",
        timestamp: 2800,
        durationMs: 1800,
        status: "ok",
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    expect(renderEasyView(records)).toBe("- step 1.8s");
  });

  it("renders a span with nested log records", () => {
    const records: LogRecord[] = [
      {
        kind: "span-open",
        spanId: "s1",
        name: "step",
        timestamp: 1000,
        extensionId: "ext",
        turnId: "t1",
      },
      {
        kind: "log",
        level: "info",
        msg: "thinking...",
        timestamp: 1200,
        extensionId: "ext",
        turnId: "t1",
        parentSpanId: "s1",
      },
      {
        kind: "span-close",
        spanId: "s1",
        name: "step",
        timestamp: 2800,
        durationMs: 1800,
        status: "ok",
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    const expected = ["- step 1.8s", "  - thinking..."].join("\n");
    expect(renderEasyView(records)).toBe(expected);
  });

  it("renders nested spans with indentation", () => {
    const records: LogRecord[] = [
      {
        kind: "span-open",
        spanId: "parent",
        name: "step",
        timestamp: 1000,
        extensionId: "ext",
        turnId: "t1",
      },
      {
        kind: "span-open",
        spanId: "child",
        name: "tool.call",
        timestamp: 1100,
        extensionId: "ext",
        turnId: "t1",
        parentSpanId: "parent",
      },
      {
        kind: "log",
        level: "info",
        msg: "executing",
        timestamp: 1200,
        extensionId: "ext",
        turnId: "t1",
        parentSpanId: "child",
      },
      {
        kind: "span-close",
        spanId: "child",
        name: "tool.call",
        timestamp: 1500,
        durationMs: 400,
        status: "ok",
        extensionId: "ext",
        turnId: "t1",
        parentSpanId: "parent",
      },
      {
        kind: "span-close",
        spanId: "parent",
        name: "step",
        timestamp: 2800,
        durationMs: 1800,
        status: "ok",
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    const expected = ["- step 1.8s", "  - tool.call 400ms", "    - executing"].join("\n");
    expect(renderEasyView(records)).toBe(expected);
  });

  it("renders a span-open without matching span-close as (open)", () => {
    const records: LogRecord[] = [
      {
        kind: "span-open",
        spanId: "s-open",
        name: "step",
        timestamp: 1000,
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    expect(renderEasyView(records)).toBe("- step (open)");
  });

  it("renders root-level log records without a parent span", () => {
    const records: LogRecord[] = [
      {
        kind: "log",
        level: "info",
        msg: "top-level",
        timestamp: 500,
        extensionId: "ext",
        turnId: "t1",
      },
      {
        kind: "log",
        level: "warn",
        msg: "a warning",
        timestamp: 600,
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    const expected = ["- top-level", "- [warn] a warning"].join("\n");
    expect(renderEasyView(records)).toBe(expected);
  });

  it("skips span-close records without a matching span-open", () => {
    const records: LogRecord[] = [
      {
        kind: "span-close",
        spanId: "orphan",
        name: "orphan",
        timestamp: 1000,
        durationMs: 100,
        status: "ok",
        extensionId: "ext",
        turnId: "t1",
      },
      {
        kind: "log",
        level: "info",
        msg: "real",
        timestamp: 2000,
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    expect(renderEasyView(records)).toBe("- real");
  });

  it("renders span with ERR status", () => {
    const records: LogRecord[] = [
      {
        kind: "span-open",
        spanId: "s1",
        name: "failing-step",
        timestamp: 1000,
        extensionId: "ext",
        turnId: "t1",
      },
      {
        kind: "span-close",
        spanId: "s1",
        name: "failing-step",
        timestamp: 1100,
        durationMs: 100,
        status: "error",
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    expect(renderEasyView(records)).toBe("- failing-step 100ms ERR");
  });

  it("renders body hint when body is present", () => {
    const records: LogRecord[] = [
      {
        kind: "span-open",
        spanId: "s1",
        name: "prompt",
        timestamp: 1000,
        extensionId: "ext",
        turnId: "t1",
        body: "x".repeat(2100),
      },
      {
        kind: "span-close",
        spanId: "s1",
        name: "prompt",
        timestamp: 1100,
        durationMs: 100,
        status: "ok",
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    expect(renderEasyView(records)).toBe("- prompt 100ms [body 2.1k]");
  });

  it("renders log record body hint", () => {
    const records: LogRecord[] = [
      {
        kind: "log",
        level: "debug",
        msg: "payload",
        timestamp: 500,
        extensionId: "ext",
        turnId: "t1",
        body: "abc",
      },
    ];
    expect(renderEasyView(records)).toBe("- [debug] payload [body 3b]");
  });

  it("renders attributes on span (up to 3)", () => {
    const records: LogRecord[] = [
      {
        kind: "span-open",
        spanId: "s1",
        name: "provider.request",
        timestamp: 1000,
        extensionId: "ext",
        turnId: "t1",
        attributes: { model: "gpt-4", method: "POST", status: 200 },
      },
      {
        kind: "span-close",
        spanId: "s1",
        name: "provider.request",
        timestamp: 1500,
        durationMs: 500,
        status: "ok",
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    const output = renderEasyView(records);
    expect(output).toContain("provider.request 500ms");
    expect(output).toContain('model="gpt-4"');
    expect(output).toContain('method="POST"');
    expect(output).toContain("status=200");
  });

  it("renders mixed records in correct order", () => {
    const records: LogRecord[] = [
      {
        kind: "span-open",
        spanId: "s1",
        name: "step",
        timestamp: 1000,
        extensionId: "ext",
        turnId: "t1",
      },
      {
        kind: "log",
        level: "info",
        msg: "inside step",
        timestamp: 1200,
        extensionId: "ext",
        turnId: "t1",
        parentSpanId: "s1",
      },
      {
        kind: "span-close",
        spanId: "s1",
        name: "step",
        timestamp: 2800,
        durationMs: 1800,
        status: "ok",
        extensionId: "ext",
        turnId: "t1",
      },
      {
        kind: "log",
        level: "info",
        msg: "after step",
        timestamp: 3000,
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    const expected = ["- step 1.8s", "  - inside step", "- after step"].join("\n");
    expect(renderEasyView(records)).toBe(expected);
  });

  it("deterministic output for same input", () => {
    const records: LogRecord[] = [
      {
        kind: "span-open",
        spanId: "s1",
        name: "step",
        timestamp: 1000,
        extensionId: "ext",
        turnId: "t1",
      },
      {
        kind: "span-close",
        spanId: "s1",
        name: "step",
        timestamp: 1800,
        durationMs: 800,
        status: "ok",
        extensionId: "ext",
        turnId: "t1",
      },
    ];
    expect(renderEasyView(records)).toBe(renderEasyView(records));
  });
});

describe("formatDuration", () => {
  it("formats milliseconds under 1s", () => {
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(59999)).toBe("60.0s");
  });

  it("formats minutes", () => {
    expect(formatDuration(60000)).toBe("1m0s");
    expect(formatDuration(90000)).toBe("1m30s");
    expect(formatDuration(125000)).toBe("2m5s");
  });
});
