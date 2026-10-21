import type {
  ConversationComputerResponse,
  CwdResponse,
  ModelResponse,
  ReasoningEffortResponse,
  SetConversationComputerRequest,
} from "@dispatch/transport-contract";
import type { Hono } from "hono";
import {
  isModelParseError,
  isReasoningEffortParseError,
  parseModelBody,
  parseReasoningEffortBody,
} from "../logic.js";
import type { RouteOptions } from "../route-options.js";
import { isValidWorkspaceSlug } from "../seam.js";

export function mount(app: Hono, options: RouteOptions): void {
  const { config: opts, log } = options;
  app.get("/conversations/:id/cwd", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const cwd = await opts.conversationStore.getCwd(conversationId);
      log.info("conversations: cwd read", { conversationId, hasCwd: cwd !== null });
      const body: CwdResponse = { conversationId, cwd };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: cwd read failure", { err });
      return c.json({ error: "Failed to read conversation cwd" }, 500);
    }
  });

  app.put("/conversations/:id/cwd", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/cwd: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.cwd !== "string" || obj.cwd.length === 0) {
      return c.json({ error: "Field 'cwd' is required and must be a non-empty string" }, 400);
    }

    // When a workspaceId is provided, assign the conversation to that
    // workspace BEFORE persisting the cwd — so a subsequent
    // GET /conversations/:id/lsp resolves a relative cwd against the
    // workspace's defaultCwd (not the server default). Omit for unchanged
    // workspace assignment (backward compatible).
    if (obj.workspaceId !== undefined) {
      if (typeof obj.workspaceId !== "string" || !isValidWorkspaceSlug(obj.workspaceId)) {
        return c.json({ error: "Invalid workspaceId" }, 400);
      }
    }

    try {
      if (typeof obj.workspaceId === "string") {
        await opts.conversationStore.ensureWorkspace(obj.workspaceId);
        await opts.conversationStore.setWorkspaceId(conversationId, obj.workspaceId);
      }
      await opts.conversationStore.setCwd(conversationId, obj.cwd);
      log.info("conversations: cwd set", { conversationId });
      const response: CwdResponse = { conversationId, cwd: obj.cwd };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: cwd set failure", { err });
      return c.json({ error: "Failed to set conversation cwd" }, 500);
    }
  });

  app.delete("/conversations/:id/cwd", async (c) => {
    const conversationId = c.req.param("id");
    try {
      await opts.conversationStore.clearCwd(conversationId);
      log.info("conversations: cwd cleared", { conversationId });
      const response: CwdResponse = { conversationId, cwd: null };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: cwd clear failure", { err });
      return c.json({ error: "Failed to clear conversation cwd" }, 500);
    }
  });

  // ─── Per-conversation computer (mirrors /conversations/:id/cwd) ──────────

  app.get("/conversations/:id/computer", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const computerId = await opts.conversationStore.getComputerId(conversationId);
      log.info("conversations: computer read", {
        conversationId,
        hasComputerId: computerId !== null,
      });
      const body: ConversationComputerResponse = { conversationId, computerId };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: computer read failure", { err });
      return c.json({ error: "Failed to read conversation computer" }, 500);
    }
  });

  app.put("/conversations/:id/computer", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/computer: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const obj = body as Record<string, unknown>;
    // `computerId` must be a string (the SSH alias) or null (clear → inherit
    // the workspace defaultComputerId → local). An empty string is rejected
    // (unlike cwd, an alias is never "empty"); null is the explicit clear.
    if (
      obj.computerId !== null &&
      (typeof obj.computerId !== "string" || obj.computerId.length === 0)
    ) {
      return c.json(
        { error: "Field 'computerId' is required and must be a non-empty string or null" },
        400,
      );
    }
    const { computerId } = obj as unknown as SetConversationComputerRequest;

    // Mirror PUT /conversations/:id/cwd: when a workspaceId is provided,
    // assign the conversation to that workspace BEFORE persisting the
    // computer, so a subsequent effective-computer resolution reads the
    // workspace's defaultComputerId. Omit for unchanged workspace assignment.
    if (obj.workspaceId !== undefined) {
      if (typeof obj.workspaceId !== "string" || !isValidWorkspaceSlug(obj.workspaceId)) {
        return c.json({ error: "Invalid workspaceId" }, 400);
      }
    }

    try {
      if (typeof obj.workspaceId === "string") {
        await opts.conversationStore.ensureWorkspace(obj.workspaceId);
        await opts.conversationStore.setWorkspaceId(conversationId, obj.workspaceId);
      }
      // null → clear (inherit/local); string → persist the alias.
      await opts.conversationStore.setComputerId(conversationId, computerId);
      log.info("conversations: computer set", { conversationId });
      const response: ConversationComputerResponse = { conversationId, computerId };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: computer set failure", { err });
      return c.json({ error: "Failed to set conversation computer" }, 500);
    }
  });

  app.delete("/conversations/:id/computer", async (c) => {
    const conversationId = c.req.param("id");
    try {
      await opts.conversationStore.clearComputerId(conversationId);
      log.info("conversations: computer cleared", { conversationId });
      const response: ConversationComputerResponse = { conversationId, computerId: null };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: computer clear failure", { err });
      return c.json({ error: "Failed to clear conversation computer" }, 500);
    }
  });

  app.get("/conversations/:id/reasoning-effort", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const reasoningEffort = await opts.conversationStore.getReasoningEffort(conversationId);
      log.info("conversations: reasoning-effort read", {
        conversationId,
        hasEffort: reasoningEffort !== null,
      });
      const body: ReasoningEffortResponse = { conversationId, reasoningEffort };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: reasoning-effort read failure", { err });
      return c.json({ error: "Failed to read conversation reasoning effort" }, 500);
    }
  });

  app.put("/conversations/:id/reasoning-effort", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/reasoning-effort: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parseReasoningEffortBody(body);
    if (isReasoningEffortParseError(parsed)) {
      log.warn("conversations/reasoning-effort: validation failed", { reason: parsed.error });
      return c.json({ error: parsed.error }, 400);
    }

    try {
      await opts.conversationStore.setReasoningEffort(conversationId, parsed);
      log.info("conversations: reasoning-effort set", { conversationId });
      const response: ReasoningEffortResponse = { conversationId, reasoningEffort: parsed };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: reasoning-effort set failure", { err });
      return c.json({ error: "Failed to set conversation reasoning effort" }, 500);
    }
  });

  app.get("/conversations/:id/model", async (c) => {
    const conversationId = c.req.param("id");
    try {
      const model = await opts.conversationStore.getModel(conversationId);
      // The Named Agent selection snapshot (present only for conversations
      // created/selected via a Named Agent). Additive — omitted when null
      // (exactOptionalPropertyTypes).
      const namedAgent = await opts.conversationStore.getNamedAgentSelection(conversationId);
      log.info("conversations: model read", {
        conversationId,
        hasModel: model !== null,
        hasNamedAgent: namedAgent !== null,
      });
      const body: ModelResponse = {
        conversationId,
        model,
        ...(namedAgent !== null ? { namedAgent } : {}),
      };
      return c.json(body, 200);
    } catch (err) {
      log.error("conversations: model read failure", { err });
      return c.json({ error: "Failed to read conversation model" }, 500);
    }
  });

  app.put("/conversations/:id/model", async (c) => {
    const conversationId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn("conversations/model: invalid JSON body");
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parseModelBody(body);
    if (isModelParseError(parsed)) {
      log.warn("conversations/model: validation failed", { reason: parsed.error });
      return c.json({ error: parsed.error }, 400);
    }

    // A non-null non-empty model persists the selection; `null` or an empty
    // string clears the key (the store treats an empty string as "delete").
    // The response carries the resulting value: the model name, or null when
    // cleared (mirroring how `getModel` returns null after a clear).
    const resultModel = parsed.model !== null && parsed.model.length > 0 ? parsed.model : null;
    const persistedValue = resultModel !== null ? resultModel : "";

    try {
      if (resultModel !== null) {
        // Set a real model. When a namedAgent snapshot accompanies it, persist
        // it too; when omitted, leave any existing snapshot UNCHANGED (a
        // raw-model set must not clear a prior Named Agent selection).
        await opts.conversationStore.setModel(conversationId, persistedValue);
        if (parsed.namedAgent !== undefined) {
          await opts.conversationStore.setNamedAgentSelection(conversationId, parsed.namedAgent);
        }
        // Read back the persisted snapshot so the response reflects the
        // resulting state (the just-set snapshot, or the left-unchanged one).
        const namedAgent = await opts.conversationStore.getNamedAgentSelection(conversationId);
        log.debug("conversations: model set", {
          conversationId,
          model: resultModel,
          hasNamedAgent: namedAgent !== null,
        });
        const response: ModelResponse = {
          conversationId,
          model: resultModel,
          ...(namedAgent !== null ? { namedAgent } : {}),
        };
        return c.json(response, 200);
      }
      // Clear: model is null/empty → clear the persisted model. The store's
      // setModel("") clear path also deletes the named-agent-selection snapshot
      // (CR: conversation-store — clearing a conversation's model clears its
      // Named Agent selection). The response therefore carries no namedAgent.
      await opts.conversationStore.setModel(conversationId, persistedValue);
      log.debug("conversations: model cleared", { conversationId });
      const response: ModelResponse = { conversationId, model: null };
      return c.json(response, 200);
    } catch (err) {
      log.error("conversations: model set failure", { err });
      return c.json({ error: "Failed to set conversation model" }, 500);
    }
  });
}
