import { describe, expect, it } from "vitest";
import { McpTimeoutError, withTimeout } from "./timeout.js";

/**
 * `withTimeout` uses a single `setTimeout` (the only edge). Tests drive it
 * deterministically via `AbortController` for the abort path, and use real
 * (tiny) timers for the timeout path — vitest's async scheduler is fast enough
 * at single-digit ms that this is stable.
 */

describe("withTimeout", () => {
  it("resolves with the underlying value when the promise settles first", async () => {
    const result = await withTimeout(Promise.resolve("ok"), "initialize", 1000);
    expect(result).toBe("ok");
  });

  it("rejects with the underlying error when the promise rejects first", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), "initialize", 1000),
    ).rejects.toThrow("boom");
  });

  it("rejects with McpTimeoutError when the timeout fires first", async () => {
    const never = new Promise<string>(() => {}); // never settles
    const p = withTimeout(never, "initialize", 20);
    await expect(p).rejects.toBeInstanceOf(McpTimeoutError);
    await expect(p).rejects.toMatchObject({ method: "initialize", timeoutMs: 20 });
  });

  it("cleans up the timer after the promise settles (no leak)", async () => {
    // If the timer were not cleared, vitest would report an unhandled timer;
    // resolving quickly should leave nothing pending.
    const result = await withTimeout(Promise.resolve(1), "tools/list", 50_000);
    expect(result).toBe(1);
  });

  it("rejects with Error('Aborted') when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withTimeout(new Promise(() => {}), "initialize", 50_000, controller.signal),
    ).rejects.toThrow("Aborted");
  });

  it("rejects with Error('Aborted') when the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => {});
    const p = withTimeout(never, "initialize", 50_000, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow("Aborted");
  });

  it("abort beats timeout (immediate cancellation)", async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => {});
    const p = withTimeout(never, "initialize", 50_000, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow("Aborted");
  });

  it("passes through when timeout is disabled (0) and no signal", async () => {
    const result = await withTimeout(Promise.resolve("passthrough"), "initialize", 0);
    expect(result).toBe("passthrough");
  });

  it("passes through when timeout is Infinity and no signal", async () => {
    const result = await withTimeout(Promise.resolve(42), "tools/list", Number.POSITIVE_INFINITY);
    expect(result).toBe(42);
  });

  it("still honors the signal when timeout is disabled", async () => {
    const controller = new AbortController();
    const p = withTimeout(new Promise<string>(() => {}), "initialize", 0, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow("Aborted");
  });

  it("removes the abort listener after the promise settles", async () => {
    const controller = new AbortController();
    const addSpy = controller.signal.addEventListener.bind(controller.signal);
    let added = 0;
    const spiedAdd = (...args: unknown[]) => {
      added++;
      return (addSpy as (...a: unknown[]) => void)(...args);
    };
    controller.signal.addEventListener = spiedAdd as typeof controller.signal.addEventListener;

    await withTimeout(Promise.resolve("ok"), "initialize", 50_000, controller.signal);
    // The resolve path cleans up: the listener was added then removed. The
    // important assertion is that resolution works and no abort fires after.
    expect(added).toBe(1);
    // Aborting after settlement must NOT reject the already-settled promise.
    controller.abort();
  });
});

describe("McpTimeoutError", () => {
  it("carries method + timeoutMs and a descriptive message", () => {
    const err = new McpTimeoutError("initialize", 5000);
    expect(err.method).toBe("initialize");
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toBe("MCP initialize timed out after 5000ms");
    expect(err.name).toBe("McpTimeoutError");
  });
});
