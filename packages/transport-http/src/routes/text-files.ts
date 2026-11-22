import type {
  TextFileContextResponse,
  TextFileDiffResponse,
  TextFileDiffVersionResponse,
  TextFileResponse,
  TextFileVersionResponse,
  TextFileWriteConflictResponse,
  TextFileWriteResponse,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";
import { computeTextFileDiff, loadTextFileDiffState } from "../text-file-diff.js";
import {
  decodeTextFile,
  isExcalidrawPath,
  parseTextFileQuery,
  parseTextFileWriteRequest,
  resolveTextFileContext,
  resolveTextFileRequest,
  type TextFileContext,
  type TextFileError,
  textFileFormat,
  textFileMaxBytes,
  validateExcalidrawText,
} from "../text-file-logic.js";
import {
  readTextFileBytes,
  statTextFileVersion,
  writeTextFileAtomic,
} from "../text-file-reader.js";

export function mount(app: Hono, { config, log }: RouteOptions): void {
  const store = config.conversationStore;
  async function contextFor(id: string): Promise<TextFileContext | TextFileError> {
    const meta = await store.getConversationMeta(id);
    if (meta === null) return { error: "Conversation not found", status: 404 };
    const workspace = await store.getWorkspace(await store.getWorkspaceId(id));
    return resolveTextFileContext({
      cwd: await store.getCwd(id),
      defaultCwd: workspace?.defaultCwd ?? null,
      computerId: await store.getComputerId(id),
      defaultComputerId: workspace?.defaultComputerId ?? null,
    });
  }

  app.get("/conversations/:id/text-file-context", async (c) => {
    try {
      if (new URL(c.req.url).searchParams.size !== 0) {
        return c.json({ error: "Text-file context does not accept query parameters" }, 400);
      }
      const conversationId = c.req.param("id");
      const context = await contextFor(conversationId);
      if ("error" in context) return c.json({ error: context.error }, context.status);
      const body: TextFileContextResponse = { conversationId, ...context };
      return c.json(body);
    } catch {
      return c.json({ error: "Failed to read conversation file context" }, 500);
    }
  });

  app.get("/conversations/:id/text-file", async (c) => {
    try {
      const query = parseTextFileQuery(new URL(c.req.url).searchParams);
      if ("error" in query) return c.json({ error: query.error }, query.status);
      const id = c.req.param("id");
      const context = await contextFor(id);
      if ("error" in context) return c.json({ error: context.error }, context.status);
      const request = resolveTextFileRequest(query, context);
      if ("error" in request) return c.json({ error: request.error }, request.status);
      const maxBytes = textFileMaxBytes(request.path);
      const result = await readTextFileBytes(request.path, maxBytes);
      if ("error" in result) return c.json({ error: result.error }, result.status);
      const decoded = decodeTextFile(result.bytes, maxBytes);
      if ("error" in decoded) return c.json({ error: decoded.error }, decoded.status);
      // Do not deliver a completed read under a context that changed during I/O.
      const latest = await contextFor(id);
      if ("error" in latest) return c.json({ error: latest.error }, latest.status);
      if (latest.cwd !== context.cwd || latest.computerId !== context.computerId) {
        return c.json({ error: "Conversation file context changed; refresh and retry" }, 409);
      }
      const body: TextFileResponse = {
        path: request.path,
        text: decoded.text,
        format: textFileFormat(request.path),
        bytes: result.bytes.byteLength,
        maxBytes,
        version: result.version,
      };
      return c.json(body);
    } catch {
      return c.json({ error: "Failed to read text file" }, 500);
    }
  });

  app.get("/conversations/:id/text-file-version", async (c) => {
    try {
      const query = parseTextFileQuery(new URL(c.req.url).searchParams);
      if ("error" in query) return c.json({ error: query.error }, query.status);
      const id = c.req.param("id");
      const context = await contextFor(id);
      if ("error" in context) return c.json({ error: context.error }, context.status);
      const request = resolveTextFileRequest(query, context);
      if ("error" in request) return c.json({ error: request.error }, request.status);
      const result = await statTextFileVersion(request.path, textFileMaxBytes(request.path));
      if ("error" in result) return c.json({ error: result.error }, result.status);
      const latest = await contextFor(id);
      if ("error" in latest) return c.json({ error: latest.error }, latest.status);
      if (latest.cwd !== context.cwd || latest.computerId !== context.computerId) {
        return c.json({ error: "Conversation file context changed; refresh and retry" }, 409);
      }
      const body: TextFileVersionResponse = { path: request.path, version: result.version };
      return c.json(body);
    } catch {
      return c.json({ error: "Failed to read text file version" }, 500);
    }
  });

  /** Shared prologue of the diff routes: parse, resolve, guard. */
  async function diffRequest(
    url: string,
    id: string,
  ): Promise<{ readonly path: string; readonly context: TextFileContext } | TextFileError> {
    const query = parseTextFileQuery(new URL(url).searchParams);
    if ("error" in query) return query;
    const context = await contextFor(id);
    if ("error" in context) return context;
    const request = resolveTextFileRequest(query, context);
    if ("error" in request) return request;
    return { path: request.path, context };
  }

  /** Do not deliver a completed git/file read under a context that changed during I/O. */
  async function contextChanged(id: string, context: TextFileContext) {
    const latest = await contextFor(id);
    if ("error" in latest) return latest;
    if (latest.cwd !== context.cwd || latest.computerId !== context.computerId) {
      return {
        error: "Conversation file context changed; refresh and retry",
        status: 409 as const,
      };
    }
    return null;
  }

  app.get("/conversations/:id/text-file-diff", async (c) => {
    try {
      const id = c.req.param("id");
      const request = await diffRequest(c.req.url, id);
      if ("error" in request) return c.json({ error: request.error }, request.status);
      const maxBytes = textFileMaxBytes(request.path);
      const state = await loadTextFileDiffState(request.path, maxBytes);
      if ("error" in state) return c.json({ error: state.error }, state.status);
      const diff = await computeTextFileDiff(request.path, maxBytes, state);
      if ("error" in diff) return c.json({ error: diff.error }, diff.status);
      const changed = await contextChanged(id, request.context);
      if (changed !== null) return c.json({ error: changed.error }, changed.status);
      const body: TextFileDiffResponse = {
        path: request.path,
        repoRoot: state.repoRoot,
        status: diff.status,
        lines: diff.lines,
        added: diff.added,
        removed: diff.removed,
        format: textFileFormat(request.path),
        maxBytes,
        version: state.version,
      };
      return c.json(body);
    } catch {
      return c.json({ error: "Failed to read text file diff" }, 500);
    }
  });

  app.get("/conversations/:id/text-file-diff-version", async (c) => {
    try {
      const id = c.req.param("id");
      const request = await diffRequest(c.req.url, id);
      if ("error" in request) return c.json({ error: request.error }, request.status);
      const state = await loadTextFileDiffState(request.path, textFileMaxBytes(request.path));
      if ("error" in state) return c.json({ error: state.error }, state.status);
      const changed = await contextChanged(id, request.context);
      if (changed !== null) return c.json({ error: changed.error }, changed.status);
      const body: TextFileDiffVersionResponse = { path: request.path, version: state.version };
      return c.json(body);
    } catch {
      return c.json({ error: "Failed to read text file diff version" }, 500);
    }
  });

  app.put("/conversations/:id/text-file", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Text-file write body must be a JSON object" }, 400);
    }
    const request = parseTextFileWriteRequest(body);
    if ("error" in request) return c.json({ error: request.error }, request.status);
    // Log target: falls back to the requested literal path until resolution succeeds.
    let resolvedPath = request.path;
    try {
      const context = await contextFor(conversationId);
      if ("error" in context) return c.json({ error: context.error }, context.status);
      const resolved = resolveTextFileRequest(
        {
          path: request.path,
          ...(request.expectedCwd !== undefined ? { expectedCwd: request.expectedCwd } : {}),
          ...(request.expectedComputerId !== undefined
            ? { expectedComputerId: request.expectedComputerId }
            : {}),
        },
        context,
      );
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      resolvedPath = resolved.path;
      if (!isExcalidrawPath(resolvedPath)) {
        return c.json({ error: "Only .excalidraw files are writable" }, 403);
      }
      const maxBytes = textFileMaxBytes(resolvedPath);
      const validated = validateExcalidrawText(request.text, maxBytes);
      if ("error" in validated) return c.json({ error: validated.error }, validated.status);
      const bytes = validated.bytes.byteLength;
      const written = await writeTextFileAtomic(
        resolvedPath,
        validated.bytes,
        request.expectedVersion,
      );
      if ("conflict" in written) {
        log.info("text-file: write conflict", { conversationId, path: resolvedPath });
        const conflict: TextFileWriteConflictResponse = {
          error: "Text file changed since it was loaded",
          version: written.version,
        };
        return c.json(conflict, 412);
      }
      if ("error" in written) {
        if (written.status === 500) {
          log.warn("text-file: write failed", {
            conversationId,
            path: resolvedPath,
            error: written.error,
          });
        }
        return c.json({ error: written.error }, written.status);
      }
      log.info("text-file: write", { conversationId, path: resolvedPath, bytes });
      const response: TextFileWriteResponse = {
        path: resolvedPath,
        version: written.version,
        bytes,
        maxBytes,
      };
      return c.json(response);
    } catch (error) {
      log.warn("text-file: write failed", {
        conversationId,
        path: resolvedPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to write text file" }, 500);
    }
  });
}
