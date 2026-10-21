import { resolve } from "node:path";
import type { ExecBackend, ExecBackendResolver } from "@dispatch/exec-backend";
import type { ToolContract, ToolResult } from "@dispatch/kernel";

// --- Pure types ---

interface ValidatedArgs {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

export type ReplacementError =
  | { readonly kind: "identical" }
  | { readonly kind: "notFound" }
  | { readonly kind: "notUnique"; readonly count: number };

export interface ReplacementSuccess {
  readonly content: string;
  readonly count: number;
}

// --- Pure functions ---

/** Pure: validate and coerce args from the model. */
export function validateArgs(args: unknown): ValidatedArgs | { readonly error: string } {
  if (args === null || args === undefined || typeof args !== "object") {
    return { error: "Error: Arguments must be an object." };
  }
  const obj = args as Record<string, unknown>;

  const rawPath = obj.path;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { error: 'Error: Missing or invalid "path" parameter (must be a non-empty string).' };
  }

  const rawOld = obj.oldString;
  if (typeof rawOld !== "string" || rawOld.length === 0) {
    return {
      error: 'Error: Missing or invalid "oldString" parameter (must be a non-empty string).',
    };
  }

  const rawNew = obj.newString;
  if (typeof rawNew !== "string") {
    return {
      error: 'Error: Missing or invalid "newString" parameter (must be a string).',
    };
  }

  const rawReplaceAll = obj.replaceAll;
  const replaceAll = rawReplaceAll === true;

  return { path: rawPath, oldString: rawOld, newString: rawNew, replaceAll };
}

/** Pure: compute the replacement result given file content + params. */
export function computeReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ReplacementSuccess | ReplacementError {
  if (oldString === newString) return { kind: "identical" };
  if (oldString === "") return { kind: "notFound" };

  // Exact matches take precedence, even if another EOL spelling also occurs.
  let matches = [...content.matchAll(new RegExp(escapeRegExp(oldString), "g"))];
  if (matches.length === 0 && oldString.includes("\n")) {
    // Only relax line endings, never other whitespace. Keep original offsets and
    // matched bytes so mixed-EOL regions need no whole-file normalization.
    const pattern = oldString.split(/\r?\n/).map(escapeRegExp).join("\r?\n");
    matches = [...content.matchAll(new RegExp(pattern, "g"))];
  }
  if (matches.length === 0) return { kind: "notFound" };
  if (!replaceAll && matches.length > 1) return { kind: "notUnique", count: matches.length };

  const parts: string[] = [];
  let offset = 0;
  for (const match of matches) {
    // Prefer the first EOL INSIDE the match. For single-line edits use the
    // terminating EOL, then the preceding EOL (last line), then LF (no EOL).
    const eol =
      /\r?\n/.exec(match[0])?.[0] ??
      /\r?\n/.exec(content.slice(match.index + match[0].length))?.[0] ??
      (content.lastIndexOf("\n", match.index - 1) > 0 &&
      content[content.lastIndexOf("\n", match.index - 1) - 1] === "\r"
        ? "\r\n"
        : "\n");
    parts.push(content.slice(offset, match.index), newString.replace(/\r?\n/g, eol));
    offset = match.index + match[0].length;
  }
  parts.push(content.slice(offset));
  const result = parts.join("");
  return result === content ? { kind: "identical" } : { content: result, count: matches.length };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Diagnostics hook ---

/**
 * Optional post-edit hook: hand the written content to the LSP extension's
 * background check queue. It is SYNCHRONOUS and fire-and-forget by contract —
 * the edit result must never wait on a language server (see
 * notes/lsp-async-diagnostics-plan.md). Injected by the extension from the LSP
 * service; absent when no LSP is available (graceful degradation).
 */
export type QueueCheckHook = (opts: {
  readonly conversationId: string;
  readonly filePath: string;
  readonly text: string;
  readonly cwd: string;
}) => void;

// --- Shell / edge ---

/**
 * Factory: create an edit_file ToolContract.
 *
 * `resolveBackend` is the injected seam: each `execute` resolves an
 * `ExecBackend` from `ctx.computerId` (undefined → local `node:fs`; a set
 * id → a remote SSH backend in a later wave). The tool programs against the
 * `ExecBackend` surface, never `node:fs` directly, so it is transport-agnostic.
 *
 * `workdir` is the fallback base directory when `ctx.cwd` is omitted. It is
 * injected so the tool is testable; `execute` prefers `ctx.cwd` when present.
 *
 * `queueCheck` is the post-edit LSP hook. It merely ENQUEUES a background
 * diagnostics check — the edit returns immediately and its result carries no
 * diagnostics. It is invoked lazily (the extension resolves the LSP service per
 * edit), skipped for REMOTE edits (`ctx.computerId` set — LSP servers are local
 * processes that can't see remote files over SFTP), and skipped when there is no
 * `ctx.conversationId` (nobody to notify). A throwing hook never fails the edit.
 */
export function createEditFileTool(deps: {
  readonly resolveBackend: ExecBackendResolver;
  readonly workdir?: string;
  readonly queueCheck?: QueueCheckHook | undefined;
}): ToolContract {
  const workdir = deps.workdir !== undefined ? resolve(deps.workdir) : undefined;

  return {
    name: "edit_file",
    description:
      "Perform an exact string replacement in an existing file. " +
      "Provide oldString (the text to find) and newString (the replacement). " +
      "By default replaces a single occurrence; set replaceAll to replace every match.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file, relative to the working directory.",
        },
        oldString: {
          type: "string",
          description: "The exact string to find and replace.",
        },
        newString: {
          type: "string",
          description: "The string to replace oldString with.",
        },
        replaceAll: {
          type: "boolean",
          description: "Replace all occurrences (default: false).",
          default: false,
        },
      },
      required: ["path", "oldString", "newString"],
    },
    concurrencySafe: false,
    async execute(args: unknown, ctx): Promise<ToolResult> {
      const validated = validateArgs(args);
      if ("error" in validated) {
        return { content: validated.error, isError: true };
      }

      const { path: relPath, oldString, newString, replaceAll } = validated;

      const effectiveBase = ctx.cwd ? resolve(ctx.cwd) : workdir;
      if (effectiveBase === undefined) {
        return {
          content:
            "Error: No working directory (neither ctx.cwd nor a baked workdir was provided).",
          isError: true,
        };
      }
      const resolvedPath = resolve(effectiveBase, relPath);

      const backend: ExecBackend = deps.resolveBackend(ctx.computerId);

      // Read the file.
      let bytes: Uint8Array;
      try {
        bytes = await backend.readFileBytes(resolvedPath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return { content: `Error: File "${relPath}" not found.`, isError: true };
        }
        return {
          content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      let content: string;
      try {
        // ignoreBOM keeps U+FEFF in the text, so re-encoding preserves the BOM.
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return { content: "Error: File is not valid UTF-8; no changes made.", isError: true };
      }

      // Pure replacement decision.
      const result = computeReplacement(content, oldString, newString, replaceAll);

      if ("kind" in result) {
        switch (result.kind) {
          case "identical":
            return {
              content: "Error: newString must differ from oldString.",
              isError: true,
            };
          case "notFound":
            return {
              content: `Error: oldString not found in content of "${relPath}".`,
              isError: true,
            };
          case "notUnique":
            return {
              content: `Error: Found ${result.count} matches for oldString in "${relPath}"; provide more surrounding context to make it unique, or set replaceAll.`,
              isError: true,
            };
        }
      }

      // Write the modified content back.
      try {
        await backend.writeFileAtomic(resolvedPath, result.content);
      } catch (err: unknown) {
        return {
          content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      const plural = result.count === 1 ? "" : "s";
      const baseContent = `Replaced ${result.count} occurrence${plural} in "${relPath}".`;

      // Fire-and-forget background diagnostics check. It never delays or
      // changes the edit result: the LSP notice (if any) arrives separately,
      // at the next tool-result boundary or in a new turn.
      //  - REMOTE: LSP servers are local processes that can't see remote files
      //    over SFTP — skip.
      //  - No conversation id: nobody to notify — skip.
      //  - A throwing hook must never fail an edit that already succeeded.
      const queueCheck = deps.queueCheck;
      if (
        queueCheck !== undefined &&
        ctx.computerId === undefined &&
        ctx.conversationId !== undefined
      ) {
        try {
          queueCheck({
            conversationId: ctx.conversationId,
            filePath: resolvedPath,
            text: result.content,
            cwd: ctx.cwd ?? process.cwd(),
          });
        } catch {
          // Diagnostics are advisory; the edit is done.
        }
      }

      return { content: baseContent };
    },
  };
}
