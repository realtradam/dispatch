import type { Attributes, Logger } from "@dispatch/kernel";
import type { MemorySample } from "@dispatch/session-orchestrator";
import { describe, expect, it } from "vitest";
import {
  buildGcAttributes,
  buildPeriodicAttributes,
  type MemoryTelemetryDeps,
  startMemoryTelemetry,
} from "./mem-telemetry.js";

/** Minimal capturing logger — records every info/debug/warn/error call. */
interface CapturedLog {
  readonly level: string;
  readonly msg: string;
  readonly attrs?: Attributes;
}

function capturingLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const record = (level: string) => (msg: string, attrs?: Attributes) => {
    logs.push({ level, msg, attrs });
  };
  const logger: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: () => {},
    child: () => logger,
    span: () => ({
      id: "s",
      log: logger,
      setAttributes: () => {},
      addLink: () => {},
      child: () => ({}) as never,
      end: () => {},
    }),
  };
  return { logger, logs };
}

const SAMPLE_A: MemorySample = {
  rss: 100 * 1024 * 1024,
  heapUsed: 40 * 1024 * 1024,
  heapTotal: 60 * 1024 * 1024,
  external: 5 * 1024 * 1024,
  arrayBuffers: 2 * 1024 * 1024,
};
const SAMPLE_B: MemorySample = {
  rss: 300 * 1024 * 1024,
  heapUsed: 80 * 1024 * 1024,
  heapTotal: 60 * 1024 * 1024,
  external: 5 * 1024 * 1024,
  arrayBuffers: 6 * 1024 * 1024,
};

describe("buildPeriodicAttributes", () => {
  it("formats the sample as MB and tags the active-conversation count", () => {
    const attrs = buildPeriodicAttributes(SAMPLE_A, 3);
    expect(attrs).toEqual({
      rssMB: 100,
      heapUsedMB: 40,
      heapTotalMB: 60,
      externalMB: 5,
      arrayBuffersMB: 2,
      activeConversations: 3,
    });
  });
});

describe("buildGcAttributes", () => {
  it("carries absolute after values plus reclaimed (before-after) delta", () => {
    const attrs = buildGcAttributes(SAMPLE_A, SAMPLE_B);
    // Absolute "after" values (SAMPLE_B).
    expect(attrs.rssMB).toBe(300);
    expect(attrs.heapUsedMB).toBe(80);
    // Reclaimed delta: before - after is negative here (memory GREW), so
    // reclaimedRssMB = round((100-300) MB) = -200.
    expect(attrs.reclaimedRssMB).toBe(-200);
    expect(attrs.reclaimedHeapUsedMB).toBe(-40);
    expect(attrs.reclaimedHeapTotalMB).toBe(0);
    expect(attrs.reclaimedArrayBuffersMB).toBe(-4);
  });

  it("shows a positive reclaimed value when GC freed memory", () => {
    const attrs = buildGcAttributes(SAMPLE_B, SAMPLE_A);
    expect(attrs.reclaimedRssMB).toBe(200);
  });
});

describe("startMemoryTelemetry", () => {
  function fakeTimers(): {
    setInterval: MemoryTelemetryDeps["setInterval"];
    clearInterval: MemoryTelemetryDeps["clearInterval"];
    tick: (name: "sample" | "gc") => void;
    cleared: { sample: number; gc: number };
  } {
    // Store the callbacks keyed by interval so we can drive either one. The
    // gc interval is always larger than the sample interval, so route the
    // larger ms to the gc callback.
    let sampleCb: (() => void) | undefined;
    let gcCb: (() => void) | undefined;
    let firstMs = 0;
    const cleared = { sample: 0, gc: 0 };
    return {
      setInterval: (fn, ms) => {
        if (firstMs === 0) {
          firstMs = ms;
          sampleCb = fn;
          return "sample" as never;
        }
        // The second timer registered is the gc one (larger interval).
        gcCb = fn;
        return "gc" as never;
      },
      clearInterval: (handle) => {
        if (handle === "sample") cleared.sample++;
        else if (handle === "gc") cleared.gc++;
      },
      tick: (name) => {
        if (name === "sample") sampleCb?.();
        else gcCb?.();
      },
      cleared,
    };
  }

  it("logs a periodic sample tagged with the active-conversation count", () => {
    const { logger, logs } = capturingLogger();
    let active = 2;
    const timers = fakeTimers();
    const handle = startMemoryTelemetry({
      logger,
      sampleMemory: () => SAMPLE_A,
      gc: () => {},
      getActiveConversationCount: () => active,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    timers.tick("sample");
    const periodic = logs.find((l) => l.msg === "memory:periodic");
    expect(periodic).toBeDefined();
    expect(periodic?.attrs?.rssMB).toBe(100);
    expect(periodic?.attrs?.activeConversations).toBe(2);

    // The count is read live (re-evaluated each tick).
    active = 5;
    timers.tick("sample");
    const periodic2 = logs.filter((l) => l.msg === "memory:periodic");
    expect(periodic2).toHaveLength(2);
    expect(periodic2[1]?.attrs?.activeConversations).toBe(5);

    handle.stop();
    expect(timers.cleared.sample).toBe(1);
    expect(timers.cleared.gc).toBe(1);
  });

  it("runs gc and logs RSS before/after on the gc interval", () => {
    const { logger, logs } = capturingLogger();
    let calls = 0;
    const samples = [SAMPLE_A, SAMPLE_B];
    const timers = fakeTimers();
    const handle = startMemoryTelemetry({
      logger,
      sampleMemory: () => samples[calls++] as MemorySample,
      gc: () => {},
      getActiveConversationCount: () => 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    timers.tick("gc");
    const gcLog = logs.find((l) => l.msg === "memory:gc");
    expect(gcLog).toBeDefined();
    // before=SAMPLE_A (call 0), after=SAMPLE_B (call 1) — rss grew 100→300.
    expect(gcLog?.attrs?.rssMB).toBe(300);
    expect(gcLog?.attrs?.reclaimedRssMB).toBe(-200);

    handle.stop();
  });

  it("actually calls the injected gc function", () => {
    const { logger } = capturingLogger();
    let gcCalls = 0;
    const timers = fakeTimers();
    const handle = startMemoryTelemetry({
      logger,
      sampleMemory: () => SAMPLE_A,
      gc: () => {
        gcCalls++;
      },
      getActiveConversationCount: () => 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    timers.tick("gc");
    expect(gcCalls).toBe(1);
    // Periodic ticks do NOT trigger gc.
    timers.tick("sample");
    expect(gcCalls).toBe(1);

    handle.stop();
  });

  it("stop is idempotent (clearing twice is harmless)", () => {
    const { logger } = capturingLogger();
    const timers = fakeTimers();
    const handle = startMemoryTelemetry({
      logger,
      sampleMemory: () => SAMPLE_A,
      gc: () => {},
      getActiveConversationCount: () => 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    handle.stop();
    handle.stop();
    // Both timers cleared exactly once each (second stop is a no-op on the
    // same handles — clear count stays at 1 per handle).
    expect(timers.cleared.sample).toBe(1);
    expect(timers.cleared.gc).toBe(1);
  });
});
