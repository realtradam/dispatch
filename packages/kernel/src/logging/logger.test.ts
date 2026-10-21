import { describe, expect, it } from "vitest";
import type { LogDeps, LogRecord, LogSink } from "../contracts/logging.js";
import { createLogger } from "./logger.js";

function harness(recordsBodies?: boolean) {
  let idCounter = 0;
  const deps: LogDeps = {
    now: () => 1000 + idCounter * 10,
    newId: () => `span-${++idCounter}`,
  };
  const records: LogRecord[] = [];
  const sink: LogSink = {
    ...(recordsBodies !== undefined ? { recordsBodies } : {}),
    emit: (r) => records.push(r),
  };
  return { logger: createLogger({ extensionId: "test" }, sink, deps), records };
}

describe("createLogger child-bound attributes", () => {
  it("merges child-bound attrs into BOTH span-open and span-close records", () => {
    const { logger, records } = harness();
    // Bind `warm: true` via child() — mirrors the cache-warming capture path.
    const warmLogger = logger.child({ conversationId: "c1", attrs: { warm: true } });

    const span = warmLogger.span("provider.request", { model: "x" });
    span.end({ attrs: { "usage.cacheReadTokens": 0 } });

    const open = records.find((r) => r.kind === "span-open");
    const close = records.find((r) => r.kind === "span-close");

    // Open carries the bound attr (pre-existing behavior).
    expect(open?.attributes?.warm).toBe(true);
    // Close MUST carry it too, so a `warm = true` query finds the closed span
    // (with its usage/status) — not just the open record.
    expect(close?.attributes?.warm).toBe(true);
    // Span-specific attrs from span()/end() are still present on close.
    expect(close?.attributes?.model).toBe("x");
    expect(close?.attributes?.["usage.cacheReadTokens"]).toBe(0);
  });

  it("omits attributes entirely when neither bound nor span attrs exist", () => {
    const { logger, records } = harness();
    const span = logger.span("bare");
    span.end();
    const close = records.find((r) => r.kind === "span-close");
    expect(close?.attributes).toBeUndefined();
  });
});

describe("lazy span bodies", () => {
  it.each([undefined, true])("records a thunk exactly once with recordsBodies=%s", (enabled) => {
    const { logger, records } = harness(enabled);
    let calls = 0;
    const body = () => {
      calls++;
      return "payload";
    };
    const span = logger.span("parent", {}, body);
    span.child("child", {}, body).end();
    span.log.span("nested", {}, body).end();
    logger.child({ turnId: "t1" }).span("scoped", {}, body).end();
    span.end();
    expect(calls).toBe(4);
    expect(records.filter((r) => r.kind === "span-open").map((r) => r.body)).toEqual([
      "payload",
      "payload",
      "payload",
      "payload",
    ]);
  });

  it("never invokes thunks or records eager bodies when the sink disables bodies", () => {
    const { logger, records } = harness(false);
    let calls = 0;
    const body = () => {
      calls++;
      throw new Error("must not run");
    };
    const span = logger.span("parent", {}, body);
    span.child("child", {}, body).end({ body: "close" });
    span.log.span("nested", {}, body).end();
    logger.child({ turnId: "t1" }).span("scoped", {}, body).end();
    logger.span("eager", {}, "eager").end();
    span.end();
    expect(calls).toBe(0);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.body === undefined)).toBe(true);
  });

  it("isolates throwing thunks while preserving the span lifecycle", () => {
    const { logger, records } = harness();
    const span = logger.span("bad-body", { kept: true }, () => {
      throw new Error("serialization failed");
    });
    span.end();
    expect(records.map((r) => r.kind)).toEqual(["span-open", "span-close"]);
    expect(records.every((r) => r.body === undefined && r.attributes?.kept === true)).toBe(true);
  });

  it("isolates sink failures with lazy bodies", () => {
    const logger = createLogger(
      { extensionId: "test" },
      {
        emit() {
          throw new Error("sink failed");
        },
      },
      { now: () => 0, newId: () => "id" },
    );
    expect(() => logger.span("test", {}, () => "body").end()).not.toThrow();
  });
});
