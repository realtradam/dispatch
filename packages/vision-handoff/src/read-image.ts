/**
 * read_image tool — lets a vision-capable model pull filesystem images into
 * its own context (plan §13).
 *
 * `consult_vision` delegates image analysis to ANOTHER model; `read_image` is
 * the complement: it is advertised ONLY to vision-capable models (the
 * model-aware tools filter hides it from non-vision models), and it reads image
 * files from disk and returns them as native image attachments so the SAME model
 * inspects them on its next step.
 *
 * The tool:
 *  1. resolves each path against `ToolExecuteContext.cwd`;
 *  2. uses `ToolExecuteContext.computerId` to select the injected local/remote
 *     execution backend;
 *  3. enforces working-directory containment;
 *  4. validates regular file, supported image MIME/extension, per-image size,
 *     total size, and count;
 *  5. returns concise text metadata plus native image attachments.
 *
 * Binary read: the `ExecBackend` surface is utf8-only (`readFile` returns a
 * string), so binary image bytes are read uniformly over the backend's `spawn`
 * by running `cat <path> | base64` and decoding the stdout. This works on both
 * the local (LOCAL) and remote (SSH) backends and routes through `computerId`
 * for backend selection (plan §13.2 point 2). GNU `base64` wraps output at 76
 * chars; all whitespace is stripped before decoding.
 */

import { resolve as nodeResolve } from "node:path";
import type { ExecBackend, ExecBackendResolver, ExecResult } from "@dispatch/exec-backend";
import type { ImageInput, ToolContract, ToolResult } from "@dispatch/kernel";
import {
  formatReadImageResult,
  mimeFromPath,
  READ_IMAGE_MAX_COUNT,
  READ_IMAGE_MAX_PER_FILE,
  type ReadImageEntry,
  resolveAndContain,
  validateImageSize,
} from "./pure.js";

/** The cap on collected base64 output before the read is aborted (bytes). */
const BASE64_OUTPUT_CAP = Math.ceil(READ_IMAGE_MAX_PER_FILE * 1.4 * 1.1);

/** Shell-quote a path for safe interpolation into a `sh -c` command. */
function shellQuote(path: string): string {
  // Single-quote, escaping any embedded single-quotes as '\''.
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Decode a base64 string (possibly with whitespace/newlines from GNU wrapping)
 * into a byte buffer. Throws on invalid input. Pure given the string.
 */
function decodeBase64(b64: string): Buffer {
  return Buffer.from(b64.replace(/\s+/g, ""), "base64");
}

/**
 * Read a single image file's bytes via the backend's `spawn` running
 * `cat <path> | base64`. Collects stdout, stripping whitespace, and decodes to
 * bytes. A dedicated AbortController aborts the spawn the instant collected
 * output exceeds {@link BASE64_OUTPUT_CAP} (bounding memory for oversized
 * files), and also fires on the parent turn signal. Throws on non-zero exit /
 * timeout / cap exceeded.
 */
async function readImageBytes(
  backend: ExecBackend,
  abs: string,
  cwd: string,
  parentSignal: AbortSignal,
): Promise<Buffer> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  let stdout = "";
  let capped = false;
  const onOutput = (data: string): void => {
    if (capped) return;
    stdout += data;
    if (stdout.length >= BASE64_OUTPUT_CAP) {
      capped = true;
      controller.abort();
    }
  };

  let result: ExecResult;
  try {
    result = await backend.spawn({
      command: `cat ${shellQuote(abs)} | base64`,
      cwd,
      signal: controller.signal,
      timeout: 30_000,
      onOutput,
    });
  } finally {
    parentSignal.removeEventListener("abort", onParentAbort);
  }

  if (capped) {
    throw new Error("image is too large (exceeded the read cap)");
  }
  if (result.aborted && !capped) throw new Error("read was aborted");
  if (result.timedOut) throw new Error("read timed out");
  if (result.exitCode !== 0) {
    throw new Error(`base64 read failed (exit ${result.exitCode?.toString() ?? "null"})`);
  }
  return decodeBase64(stdout);
}

/** Validated args for read_image. */
interface ValidatedArgs {
  readonly paths: readonly string[];
}
function validateArgs(args: unknown): ValidatedArgs | { readonly error: string } {
  if (args === null || args === undefined || typeof args !== "object") {
    return { error: "Error: Arguments must be an object." };
  }
  const obj = args as Record<string, unknown>;
  const rawPaths = obj.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    return { error: "Error: 'paths' must be a non-empty array of image paths." };
  }
  if (rawPaths.length > READ_IMAGE_MAX_COUNT) {
    return {
      error: `Error: 'paths' has ${rawPaths.length} entries; the maximum is ${READ_IMAGE_MAX_COUNT}.`,
    };
  }
  const paths: string[] = [];
  for (const p of rawPaths) {
    if (typeof p !== "string" || p.trim().length === 0) {
      return { error: "Error: every entry in 'paths' must be a non-empty string." };
    }
    paths.push(p);
  }
  return { paths };
}

/**
 * Factory: create a read_image ToolContract.
 *
 * `resolveBackend` is the injected seam: each `execute` resolves an
 * `ExecBackend` from `ctx.computerId` (undefined → local; a set id → remote
 * SSH), exactly like `read_file`. The tool programs against the `ExecBackend`
 * surface, never `node:fs` directly, so it is transport-agnostic.
 */
export function createReadImageTool(deps: {
  readonly resolveBackend: ExecBackendResolver;
  readonly workdir?: string;
}): ToolContract {
  const workdir = deps.workdir !== undefined ? nodeResolve(deps.workdir) : undefined;

  return {
    name: "read_image",
    description:
      "Read one or more image files from disk into your context as native image " +
      "attachments, so you can inspect them directly on your next step. Resolve " +
      "each path against the working directory (cwd). Supports png, jpg, jpeg, " +
      "webp, gif, bmp. Only advertised to vision-capable models. Use this when " +
      "a path is referenced in code and you need to actually see the image.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Paths to image files, relative to the working directory (or absolute " +
            "within it). Up to 10 images per call.",
        },
      },
      required: ["paths"],
    },
    concurrencySafe: true,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const validated = validateArgs(args);
      if ("error" in validated) {
        return { content: validated.error, isError: true };
      }
      const { paths } = validated;

      const effectiveBase = ctx.cwd ? nodeResolve(ctx.cwd) : workdir;
      if (effectiveBase === undefined) {
        return {
          content:
            "Error: No working directory (neither ctx.cwd nor a baked workdir was provided).",
          isError: true,
        };
      }

      const backend = deps.resolveBackend(ctx.computerId);
      const span = ctx.log.span("read_image.execute", {
        pathCount: paths.length,
        ...(ctx.computerId !== undefined ? { computerId: ctx.computerId } : {}),
      });

      const entries: ReadImageEntry[] = [];
      const images: ImageInput[] = [];
      let runningTotal = 0;

      for (const path of paths) {
        // 1 + 3: resolve against cwd + enforce containment.
        const contained = resolveAndContain(
          (base, rel) => nodeResolve(base, rel),
          path,
          effectiveBase,
        );
        if ("error" in contained) {
          span.end({ err: contained.error });
          return { content: `Error: ${contained.error}`, isError: true };
        }
        const abs = contained.abs;

        // 4 (MIME/extension): supported image type.
        const mimeType = mimeFromPath(abs);
        if (mimeType === undefined) {
          const msg = `Error: "${path}" is not a supported image type (use png, jpg, jpeg, webp, gif, or bmp).`;
          span.end({ err: msg });
          return { content: msg, isError: true };
        }

        // 2 + 4 (regular file): stat via the selected backend.
        let isFile: boolean;
        try {
          const stat = await backend.stat(abs);
          isFile = stat.isFile;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            span.end({ err: "not found" });
            return { content: `Error: File "${path}" not found.`, isError: true };
          }
          const msg = `Error reading path "${path}": ${err instanceof Error ? err.message : String(err)}`;
          span.end({ err: msg });
          return { content: msg, isError: true };
        }
        if (!isFile) {
          const msg = `Error: "${path}" is not a regular file (directories are not images).`;
          span.end({ err: msg });
          return { content: msg, isError: true };
        }

        // Read bytes uniformly via the backend's spawn (base64).
        let bytes: Buffer;
        try {
          bytes = await readImageBytes(backend, abs, effectiveBase, ctx.signal);
        } catch (err: unknown) {
          const msg = `Error reading image "${path}": ${err instanceof Error ? err.message : String(err)}`;
          span.end({ err: msg });
          return { content: msg, isError: true };
        }

        // 4 (size): per-image + total.
        const sizeErr = validateImageSize(bytes.length, runningTotal);
        if (sizeErr !== undefined) {
          span.end({ err: sizeErr });
          return { content: `Error: "${path}": ${sizeErr}`, isError: true };
        }

        runningTotal += bytes.length;
        const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
        entries.push({ path, abs, mimeType, size: bytes.length, dataUrl });
        images.push({ url: dataUrl, mimeType });
      }

      span.end({ attrs: { images: entries.length } });
      // 5: text metadata + native image attachments.
      return { content: formatReadImageResult(entries), images };
    },
  };
}
