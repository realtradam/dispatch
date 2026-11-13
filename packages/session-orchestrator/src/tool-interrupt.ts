import type { ToolContract, ToolResult } from "@dispatch/kernel";

export const INTERRUPTED_NOT_STARTED_MESSAGE =
  "Not run: the user interrupted this step before this call started.";

/** Pure. `ms < 60_000` → "12.3 seconds" (one decimal); else "2 min 5 s" (both floored). */
export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} seconds`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/** Pure. */
export function interruptedMessage(elapsedMs: number): string {
  return `Interrupted by the user after ${formatElapsed(elapsedMs)}. The call was stopped before it finished; anything it already did has not been undone.`;
}

export interface ToolInterrupter {
  /** Wrap a turn's tools so their calls can be interrupted. Every other field of each tool is preserved. */
  readonly wrap: (tools: readonly ToolContract[]) => readonly ToolContract[];
  /** Number of calls currently executing. */
  readonly runningCount: () => number;
  /**
   * Interrupt every running call and mark the current step interrupted, so
   * calls that start before the next `reset()` are not run. Returns how many
   * running calls were interrupted.
   */
  readonly interrupt: () => number;
  /** Clear the step-interrupted mark. Called at the end of every step. */
  readonly reset: () => void;
}

interface RunningCall {
  readonly controller: AbortController;
  readonly startedAt: number;
}

export function createToolInterrupter(deps: { readonly now: () => number }): ToolInterrupter {
  let stepInterrupted = false;
  const running = new Set<RunningCall>();

  const wrap = (tools: readonly ToolContract[]): readonly ToolContract[] =>
    tools.map((tool) => ({
      ...tool,
      execute: async (args: unknown, ctx): Promise<ToolResult> => {
        if (stepInterrupted) {
          return { content: INTERRUPTED_NOT_STARTED_MESSAGE, isError: true };
        }

        const controller = new AbortController();
        const call: RunningCall = { controller, startedAt: deps.now() };
        running.add(call);

        let toolPromise: Promise<ToolResult>;
        try {
          toolPromise = tool.execute(args, {
            ...ctx,
            signal: AbortSignal.any([ctx.signal, controller.signal]),
          });
        } catch (error) {
          running.delete(call);
          throw error;
        }

        // Attaching both handlers also marks a later rejection of the orphaned
        // tool promise as handled, so interrupting cannot surface an unhandled
        // rejection.
        const settled = toolPromise.then(
          (value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );

        const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
          if (controller.signal.aborted) {
            resolve({ kind: "aborted" });
            return;
          }
          controller.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
            once: true,
          });
        });

        try {
          const outcome = await Promise.race([settled, aborted]);
          if (outcome.kind === "aborted") {
            return {
              content: interruptedMessage(deps.now() - call.startedAt),
              isError: true,
            };
          }
          if (outcome.kind === "error") throw outcome.error;
          return outcome.value;
        } finally {
          running.delete(call);
        }
      },
    }));

  const runningCount = (): number => running.size;

  const interrupt = (): number => {
    stepInterrupted = true;
    let interrupted = 0;
    for (const call of running) {
      call.controller.abort();
      interrupted++;
    }
    return interrupted;
  };

  const reset = (): void => {
    stepInterrupted = false;
  };

  return { wrap, runningCount, interrupt, reset };
}
