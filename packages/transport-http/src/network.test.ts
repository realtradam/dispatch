import { afterEach, describe, expect, it, vi } from "vitest";
import { startListeners } from "./extension.js";

describe("HTTP listener lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  it("warns, retries Tailscale after 10s, and clears retries on stop", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const stop = vi.fn();
    let attempts = 0;
    const listeners = startListeners(
      ["PII_REDACTED_DEV_IPV4_01"],
      ["PII_REDACTED_DEV_IPV4_01"],
      () => {
        if (++attempts === 1) throw new Error("not assigned");
        return { stop };
      },
      { warn },
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(attempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    listeners.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("cancels a still-failing retry on deactivate", () => {
    vi.useFakeTimers();
    const bind = vi.fn(() => {
      throw new Error("unavailable");
    });
    const listeners = startListeners(["PII_REDACTED_DEV_IPV4_01"], ["PII_REDACTED_DEV_IPV4_01"], bind, {
      warn: vi.fn(),
    });
    listeners.stop();
    vi.advanceTimersByTime(20_000);
    expect(bind).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rolls back earlier listeners on fatal loopback failure", () => {
    const stop = vi.fn();
    expect(() =>
      startListeners(
        ["127.0.0.1", "::1"],
        [],
        (address) => {
          if (address === "::1") throw new Error("occupied");
          return { stop };
        },
        { warn: vi.fn() },
      ),
    ).toThrow("occupied");
    expect(stop).toHaveBeenCalledOnce();
  });
});
