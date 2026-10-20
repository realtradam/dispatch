import { resolve } from "node:path";
import type { ExecBackendResolver } from "@dispatch/exec-backend";
import type { ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";

const DEFAULT_TIMEOUT = 120_000;
const OUTPUT_CAP = 50_000;
const HARD_LIMIT = 50_000_000;
const STREAM_LIMIT = 1_000_000;
const STREAM_BATCH = 8_000;

export interface ValidatedArgs {
  readonly command: string;
  readonly timeout: number;
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export function validateArgs(args: unknown): ValidatedArgs | { readonly error: string } {
  if (args === null || args === undefined || typeof args !== "object") {
    return { error: "Error: Arguments must be an object." };
  }
  const obj = args as Record<string, unknown>;

  const rawCommand = obj.command;
  if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) {
    return { error: 'Error: Missing or empty "command" parameter (must be a non-empty string).' };
  }

  let timeout = DEFAULT_TIMEOUT;
  if (obj.timeout !== undefined) {
    const n = Number(obj.timeout);
    if (!Number.isFinite(n) || n < 1) {
      return { error: 'Error: Invalid "timeout" parameter (must be a positive number).' };
    }
    timeout = Math.floor(n);
  }

  return { command: rawCommand, timeout };
}

function createCapture(cap: number) {
  const headCap = Math.floor(cap * 0.4);
  const tailCap = cap - headCap;
  let head = "";
  let tail = "";
  let bytes = 0;
  let chars = 0;
  return {
    append(data: string) {
      bytes += Buffer.byteLength(data);
      chars += data.length;
      const take = Math.min(headCap - head.length, data.length);
      head += data.slice(0, take);
      tail = (tail + data.slice(take)).slice(-tailCap);
      return bytes;
    },
    text() {
      if (chars <= cap) return head + tail;
      // Do not expose half a surrogate pair at either retained boundary.
      const first = head.replace(/[\uD800-\uDBFF]$/, "");
      const last = tail.replace(/^[\uDC00-\uDFFF]/, "");
      const omitted = bytes - Buffer.byteLength(first + last);
      return `${first}\n…[${omitted} bytes omitted]…\n${last}`;
    },
  };
}

export function truncateOutput(output: string, cap: number): string {
  if (output.length <= cap) return output;
  const capture = createCapture(cap);
  capture.append(output);
  return capture.text();
}

export function buildResult(params: {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly output: string;
  readonly cap: number;
}): ToolResult {
  if (params.aborted) {
    return {
      content: truncateOutput(params.output, params.cap),
      isError: true,
    };
  }
  if (params.timedOut) {
    const content = truncateOutput(params.output, params.cap);
    return {
      content: `${content}\n\n[Command timed out]`,
      isError: true,
    };
  }
  const exitCode = params.exitCode;
  if (exitCode !== 0) {
    return {
      content: truncateOutput(params.output, params.cap),
      isError: true,
    };
  }
  return {
    content: truncateOutput(params.output, params.cap),
  };
}

export function createRunShellTool(deps: {
  readonly workdir: string;
  readonly resolveBackend: ExecBackendResolver;
  readonly outputCap?: number;
}): ToolContract {
  const workdir = resolve(deps.workdir);
  const cap = deps.outputCap ?? OUTPUT_CAP;

  return {
    name: "run_shell",
    description:
      "Execute a shell command and return its output. " +
      "Use for running CLI tools, scripts, or system commands.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        timeout: {
          type: "number",
          description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}).`,
          default: DEFAULT_TIMEOUT,
        },
      },
      required: ["command"],
    },
    concurrencySafe: false,
    async execute(args: unknown, ctx: ToolExecuteContext): Promise<ToolResult> {
      const validated = validateArgs(args);
      if ("error" in validated) {
        return { content: validated.error, isError: true };
      }

      const { command, timeout } = validated;
      const effectiveCwd = ctx.cwd ? resolve(ctx.cwd) : workdir;

      if (ctx.signal.aborted) {
        return buildResult({
          exitCode: null,
          timedOut: false,
          aborted: true,
          output: "",
          cap,
        });
      }

      const capture = createCapture(cap);
      const limitController = new AbortController();
      const signal = AbortSignal.any([ctx.signal, limitController.signal]);
      let limited = false;
      let streamedBytes = 0;
      let pendingBytes = 0;
      const pending = new Map<"stdout" | "stderr", string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        clearTimeout(timer);
        timer = undefined;
        for (const [stream, data] of pending) ctx.onOutput(data, stream);
        pending.clear();
        pendingBytes = 0;
      };
      const onOutput = (data: string, stream: "stdout" | "stderr") => {
        if (limited) return;
        if (capture.append(data) > HARD_LIMIT) {
          limited = true;
          limitController.abort();
        }
        if (streamedBytes > STREAM_LIMIT) return;
        const buffer = Buffer.from(data);
        let offset = 0;
        while (offset < buffer.length && streamedBytes < STREAM_LIMIT) {
          const size = Math.min(STREAM_BATCH - pendingBytes, STREAM_LIMIT - streamedBytes);
          // A fresh streaming decoder drops only an incomplete final UTF-8 sequence.
          const part = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
            buffer.subarray(offset, offset + size),
            {
              stream: true,
            },
          );
          const bytes = Buffer.byteLength(part);
          if (bytes === 0) {
            flush();
            // The global budget may have less room than the next character needs.
            if (size === STREAM_LIMIT - streamedBytes) break;
            continue;
          }
          pending.set(stream, (pending.get(stream) ?? "") + part);
          pendingBytes += bytes;
          streamedBytes += bytes;
          offset += bytes;
          if (pendingBytes === STREAM_BATCH) flush();
          else timer ??= setTimeout(flush, 100);
        }
        if (
          (offset < buffer.length || streamedBytes === STREAM_LIMIT) &&
          streamedBytes <= STREAM_LIMIT
        ) {
          flush();
          ctx.onOutput("\n[streaming truncated at 1 MB]\n", "stderr");
          streamedBytes = STREAM_LIMIT + 1;
        }
      };

      const backend = deps.resolveBackend(ctx.computerId);

      let spawnResult: SpawnResult;

      try {
        spawnResult = await backend.spawn({
          command,
          cwd: effectiveCwd,
          signal,
          timeout,
          onOutput,
        });
      } catch (err: unknown) {
        if (ctx.signal.aborted) {
          return buildResult({
            exitCode: null,
            timedOut: false,
            aborted: true,
            output: capture.text(),
            cap: Number.POSITIVE_INFINITY,
          });
        }
        return {
          content: `Error spawning command: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      } finally {
        flush();
      }

      if (limited) {
        return {
          content: `${capture.text()}\n[Command killed: output exceeded 50 MB]`,
          isError: true,
        };
      }
      return buildResult({
        exitCode: spawnResult.exitCode,
        timedOut: spawnResult.timedOut,
        aborted: spawnResult.aborted,
        output: capture.text(),
        cap: Number.POSITIVE_INFINITY,
      });
    },
  };
}
