/**
 * Timeout + abort helper for MCP operations.
 *
 * A single misbehaving or framing-incompatible MCP server must never be able to
 * hang an agent turn indefinitely: the JSON-RPC `initialize` / `tools/list`
 * requests are awaited in-band during the per-turn tools filter, so a server
 * that never responds would block the whole turn forever. `withTimeout` bounds
 * any such awaited operation by BOTH a timeout (always) and an optional
 * `AbortSignal` (so the turn's stop can interrupt an in-flight connect).
 *
 * Edge effect: uses `setTimeout` (the clock is the only I/O). The timer + the
 * signal listener are always cleaned up on settlement, so a resolved operation
 * never leaks a pending timer. The underlying promise ALWAYS has a handler
 * attached (even when abort/timeout wins first), so it can never surface as an
 * unhandled rejection. Mocking the OUTERMOST edge (real clock) is fine; tests
 * drive this via `AbortController` (deterministic) rather than the timer.
 */

/** Default per-operation timeout for MCP handshake/tool-list requests (ms). */
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Backstop timeout bounding the ENTIRE per-turn MCP connect phase (spawn +
 * initialize + listTools across all configured servers), applied by the tools
 * filter. A misbehaving or framing-incompatible server cannot hang a turn
 * longer than this; on expiry the filter degrades gracefully (skips MCP tools
 * for that turn) instead of blocking the turn. Generous enough to absorb a
 * legitimate slow server startup (e.g. a browser-launching MCP server).
 */
export const MCP_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Raised when an MCP operation does not settle within its timeout. Distinct
 * from a plain `Error` so callers (the manager's broken-state tracking, tests)
 * can tell a timeout/incompatibility apart from a server-reported RPC error.
 */
export class McpTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`MCP ${method} timed out after ${timeoutMs}ms`);
    this.name = "McpTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race `promise` against a timeout (always) and an optional `AbortSignal`.
 * Resolves/rejects with `promise`'s outcome if it settles first; rejects with
 * `McpTimeoutError` on timeout, or `Error("Aborted")` if `signal` aborts first.
 *
 * @param method  JSON-RPC method name (for the timeout message).
 * @param timeoutMs Milliseconds before a timeout is raised. Pass `0` or
 *   `Infinity` to disable the timeout (only the `signal` then bounds the call).
 * @param signal  Optional abort signal — typically the turn's signal, so
 *   `POST /conversations/:id/stop` can interrupt a stuck connect immediately.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  method: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  // No timeout and no signal → pass straight through (nothing to race).
  const hasTimeout = timeoutMs > 0 && Number.isFinite(timeoutMs);
  if (!hasTimeout && signal === undefined) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      finish(() => reject(new Error("Aborted")));
    };

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    };

    if (hasTimeout) {
      timer = setTimeout(
        () => finish(() => reject(new McpTimeoutError(method, timeoutMs))),
        timeoutMs,
      );
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        // Already aborted: abort wins immediately. The `.then` below still
        // attaches a handler so the underlying promise never rejects unhandled.
        finish(() => reject(new Error("Aborted")));
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Always attach handlers so the underlying promise is never unhandled —
    // even when abort/timeout already won (settled), this is a no-op.
    promise.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}
