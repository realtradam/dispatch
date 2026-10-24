import type { TextFileContextResponse, TextFileResponse } from "@dispatch/transport-contract";
import type { Hono } from "hono";
import type { RouteOptions } from "../route-options.js";
import {
  decodeTextFile,
  parseTextFileQuery,
  resolveTextFileContext,
  resolveTextFileRequest,
  TEXT_FILE_MAX_BYTES,
  type TextFileContext,
  type TextFileError,
  textFileFormat,
} from "../text-file-logic.js";
import { readTextFileBytes } from "../text-file-reader.js";

export function mount(app: Hono, { config }: RouteOptions): void {
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
      const result = await readTextFileBytes(request.path);
      if ("error" in result) return c.json({ error: result.error }, result.status);
      const decoded = decodeTextFile(result.bytes);
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
        maxBytes: TEXT_FILE_MAX_BYTES,
      };
      return c.json(body);
    } catch {
      return c.json({ error: "Failed to read text file" }, 500);
    }
  });
}
