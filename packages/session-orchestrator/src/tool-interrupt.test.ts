import type { Logger, ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  createToolInterrupter,
  formatElapsed,
  INTERRUPTED_NOT_STARTED_MESSAGE,
  interruptedMessage,
} from "./tool-interrupt.js";

function fakeLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return fakeLogger();
    },
    span() {
      const span: ReturnType<Logger["span"]> = {
        id: "fake-span",
        log: fakeLogger(),
        setAttributes() {},
        addLink() {},
        child() {
          return span;
        },
        end() {},
      };
      return span;
    },
  };
}

function makeContext(signal: AbortSignal): ToolExecuteContext {
  return { toolCallId: "call-1", onOutput() {}, signal, log: fakeLogger() };
}

function makeTool(execute: ToolContract["execute"]): ToolContract {
  return { name: "tool", description: "a tool", parameters: { type: "object" }, execute };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("formatElapsed", () => {
  it("formats sub-minute durations with one decimal", () => {
    expect(formatElapsed(0)).toBe("0.0 seconds");
    expect(formatElapsed(450)).toBe("0.5 seconds");
    expect(formatElapsed(12_345)).toBe("12.3 seconds");
    expect(formatElapsed(59_999)).toBe("60.0 seconds");
  });

  it("formats minute-plus durations with floored minutes and seconds", () => {
    expect(formatElapsed(60_000)).toBe("1 min 0 s");
    expect(formatElapsed(125_000)).toBe("2 min 5 s");
  });
});

describe("interruptedMessage", () => {
  it("names the elapsed time and the non-undo guarantee", () => {
    expect(interruptedMessage(12_345)).toBe(
      "Interrupted by the user after 12.3 seconds. The call was stopped before it finished; anything it already did has not been undone.",
    );
  });
});

describe("createToolInterrupter", () => {
  it("preserves every non-execute field of each tool", () => {
    const interrupter = createToolInterrupter({ now: () => 0 });
    const original: ToolContract = {
      name: "shell",
      description: "run a command",
      parameters: { type: "object", required: ["command"] },
      execute: async () => ({ content: "ok" }),
      concurrencySafe: false,
    };

    const [wrapped] = interrupter.wrap([original]);

    expect(wrapped?.name).toBe("shell");
    expect(wrapped?.description).toBe("run a command");
    expect(wrapped?.parameters).toEqual({ type: "object", required: ["command"] });
    expect(wrapped?.concurrencySafe).toBe(false);
    expect(wrapped?.execute).not.toBe(original.execute);
  });

  it("returns a normal result and returns runningCount to 0", async () => {
    const interrupter = createToolInterrupter({ now: () => 1_000 });
    const [wrapped] = interrupter.wrap([makeTool(async () => ({ content: "done" }))]);

    const result = await wrapped?.execute({}, makeContext(new AbortController().signal));

    expect(result).toEqual({ content: "done" });
    expect(interrupter.runningCount()).toBe(0);
  });

  it("interrupts a running call with elapsed time and aborts the tool's signal", async () => {
    let now = 0;
    const interrupter = createToolInterrupter({ now: () => now });
    const observed: { signal?: AbortSignal } = {};
    const pending = deferred<ToolResult>();
    const [wrapped] = interrupter.wrap([
      makeTool((_args, ctx) => {
        observed.signal = ctx.signal;
        return pending.promise;
      }),
    ]);

    const running = wrapped?.execute({}, makeContext(new AbortController().signal));
    expect(interrupter.runningCount()).toBe(1);

    now = 12_345;
    expect(interrupter.interrupt()).toBe(1);

    const result = await running;
    expect(result).toEqual({
      content:
        "Interrupted by the user after 12.3 seconds. The call was stopped before it finished; anything it already did has not been undone.",
      isError: true,
    });
    expect(observed.signal?.aborted).toBe(true);
    expect(interrupter.runningCount()).toBe(0);
  });

  it("does not execute a call that starts after interrupt() and before reset()", async () => {
    const interrupter = createToolInterrupter({ now: () => 0 });
    let executions = 0;
    const [wrapped] = interrupter.wrap([
      makeTool(async () => {
        executions++;
        return { content: "ran" };
      }),
    ]);

    interrupter.interrupt();
    const result = await wrapped?.execute({}, makeContext(new AbortController().signal));

    expect(result).toEqual({ content: INTERRUPTED_NOT_STARTED_MESSAGE, isError: true });
    expect(executions).toBe(0);
    expect(interrupter.runningCount()).toBe(0);
  });

  it("runs calls again after reset()", async () => {
    const interrupter = createToolInterrupter({ now: () => 0 });
    const [wrapped] = interrupter.wrap([makeTool(async () => ({ content: "ran" }))]);

    interrupter.interrupt();
    interrupter.reset();

    const result = await wrapped?.execute({}, makeContext(new AbortController().signal));
    expect(result).toEqual({ content: "ran" });
  });

  it("forwards the caller's own signal abort to the tool", async () => {
    const interrupter = createToolInterrupter({ now: () => 0 });
    const caller = new AbortController();
    const observed: { signal?: AbortSignal } = {};
    const pending = deferred<ToolResult>();
    const [wrapped] = interrupter.wrap([
      makeTool((_args, ctx) => {
        observed.signal = ctx.signal;
        return pending.promise;
      }),
    ]);

    const running = wrapped?.execute({}, makeContext(caller.signal));
    caller.abort();

    expect(observed.signal?.aborted).toBe(true);
    pending.resolve({ content: "after abort" });
    await expect(running).resolves.toEqual({ content: "after abort" });
  });

  it("propagates a rejecting tool and unregisters it", async () => {
    const interrupter = createToolInterrupter({ now: () => 0 });
    const [wrapped] = interrupter.wrap([
      makeTool(async () => {
        throw new Error("boom");
      }),
    ]);

    await expect(wrapped?.execute({}, makeContext(new AbortController().signal))).rejects.toThrow(
      "boom",
    );
    expect(interrupter.runningCount()).toBe(0);
  });

  it("swallows the later rejection of an interrupted call", async () => {
    const interrupter = createToolInterrupter({ now: () => 0 });
    const pending = deferred<ToolResult>();
    const [wrapped] = interrupter.wrap([makeTool(() => pending.promise)]);

    const running = wrapped?.execute({}, makeContext(new AbortController().signal));
    interrupter.interrupt();
    const result = await running;
    expect(result).toMatchObject({ isError: true });

    pending.reject(new Error("late failure"));
    // Let the orphaned rejection settle; an unhandled rejection would fail the suite.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(interrupter.runningCount()).toBe(0);
  });

  it("interrupts two concurrent calls", async () => {
    const interrupter = createToolInterrupter({ now: () => 0 });
    const first = deferred<ToolResult>();
    const second = deferred<ToolResult>();
    const [a, b] = interrupter.wrap([
      makeTool(() => first.promise),
      makeTool(() => second.promise),
    ]);

    const runningA = a?.execute({}, makeContext(new AbortController().signal));
    const runningB = b?.execute({}, makeContext(new AbortController().signal));
    expect(interrupter.runningCount()).toBe(2);

    expect(interrupter.interrupt()).toBe(2);

    await expect(runningA).resolves.toMatchObject({ isError: true });
    await expect(runningB).resolves.toMatchObject({ isError: true });
    expect(interrupter.runningCount()).toBe(0);
  });
});
