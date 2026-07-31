/**
 * AgentManagementService — the imperative shell that wires injected stores +
 * the session-orchestrator to the pure decision logic in `pure.ts` (plan P2).
 *
 * Effects (conversation-store, credential-store, orchestrator, filesystem,
 * event-bus) are injected via {@link AgentManagementDeps}; decision logic is
 * pure. The service is useful independently of the AI tools — `vision-handoff`
 * calls `summon` with a restricted tool policy, and tests inject fakes.
 *
 * Summon algorithm (plan §5) — executed in this exact order:
 *  1. Generate a new conversationId (UUID).
 *  2. Resolve the caller's effective workspace, working directory, computer.
 *  3. Persist `parentConversationId` + `toolPolicy` BEFORE calling startTurn
 *     (separate store keys — never pre-create the meta row) so the first turn's
 *     tool-assembly filter chain sees the policy.
 *  4. Call `orchestrator.startTurn(...)` (the orchestrator re-stamps lineage +
 *     policy idempotently and handles new-conversation workspace/title/system-
 *     prompt setup).
 *  5. Return the conversation id, workspace, status, and started flag.
 */

import type { ConversationStore } from "@dispatch/conversation-store";
import type { CredentialStore } from "@dispatch/credential-store";
import type {
  AgentEvent,
  ChatMessage,
  ConversationMeta,
  ConversationStatus,
  ConversationToolPolicy,
  EventHookDescriptor,
  Logger,
} from "@dispatch/kernel";
import type { QueuedMessage } from "@dispatch/wire";
import { conversationOpened } from "@dispatch/session-orchestrator";
import type {
  SessionOrchestrator,
  StartTurnInput,
} from "@dispatch/session-orchestrator";
import type {
  AgentEntry,
  AgentManagementService,
  CancelAgentMessageInput,
  CancelAgentMessageResult,
  ListAgentsInput,
  ListAgentsResult,
  ListModelsInput,
  ListModelsResult,
  ModelEntry,
  OpenAgentInput,
  OpenAgentResult,
  ReadAgentInput,
  ReadAgentResult,
  Result,
  SendAgentInput,
  SendAgentResult,
  SummonAgentInput,
  SummonAgentResult,
} from "./types.js";
import { err, ok } from "./types.js";
export { agentManagementHandle } from "./types.js";
import {
  clampLimit,
  decideAccess,
  extractLastError,
  extractLastAssistantReply,
  filterByQuery,
  filterByStatus,
  filterModelEntries,
  formatFileAttachments,
  parseToolAccess,
  resolveShortId,
  resolveVision,
  sortByActivityDesc,
  toAgentEntry,
  truncateText,
  type AccessOperation,
} from "./pure.js";

// ─── Dependencies (all injected — no ambient state) ─────────────────────────

export interface AgentManagementDeps {
  readonly conversationStore: ConversationStore;
  readonly credentialStore: CredentialStore;
  /** Lazily resolve the session-orchestrator; `undefined` when not loaded. */
  readonly resolveOrchestrator: () => SessionOrchestrator | undefined;
  /** Emit a typed event hook (the `conversationOpened` signal for open_agent). */
  readonly emit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;
  /**
   * Read a file as UTF-8, resolving a relative path against `cwd` and enforcing
   * working-directory containment. Throws on missing/directory/binary/oversized.
   * The shell edge — real `node:fs` in production; a fake in tests.
   */
  readonly readFileContent: (path: string, cwd: string | undefined) => Promise<string>;
  /** Generate a new conversation id. Defaults to `crypto.randomUUID`. */
  readonly generateId: () => string;
  readonly logger: Logger;
  // ── bounds ──
  readonly maxWaitMs: number;
  readonly defaultListLimit: number;
  readonly maxListLimit: number;
  readonly defaultModelLimit: number;
  readonly maxModelLimit: number;
  readonly maxFileBytes: number;
  readonly defaultReadChars: number;
  readonly maxReadChars: number;
}

// ─── Wait outcome ───────────────────────────────────────────────────────────

export type WaitOutcome = "settled" | "timeout" | "aborted";

// ─── Factory ────────────────────────────────────────────────────────────────

export function createAgentManagementService(deps: AgentManagementDeps): AgentManagementService {
  const log = deps.logger;
  const store = deps.conversationStore;

  // ── private: orchestrator guard ───────────────────────────────────────────

  function requireOrchestrator(): SessionOrchestrator | undefined {
    return deps.resolveOrchestrator();
  }

  // ── private: lineage walks (I/O-bound shell ops) ──────────────────────────

  /**
   * Walk the parent chain UP from `targetId` until we reach `callerId` (a
   * descendant) or `null`/a cycle (not a descendant). O(depth); one store read
   * per level. Used to authorize a FULL id (cheap single-target check).
   */
  async function isDescendantOf(callerId: string, targetId: string): Promise<boolean> {
    let current: string | null = targetId;
    const visited = new Set<string>();
    while (current !== null) {
      if (current === callerId) return true;
      if (visited.has(current)) return false; // cycle guard
      visited.add(current);
      current = await store.getParentConversationId(current);
    }
    return false;
  }

  /**
   * Collect ALL descendant ids of `callerId` via BFS down the children tree
   * (listChildren). Cycle-protected. Used to resolve short-ID prefixes against
   * the authorized set and to mark `manageable` in workspace listings.
   */
  async function collectDescendants(rootId: string): Promise<Set<string>> {
    const descendants = new Set<string>();
    const queue: string[] = [rootId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      if (descendants.has(id)) continue;
      descendants.add(id);
      const children = await store.listChildren(id);
      for (const child of children) {
        if (!descendants.has(child)) queue.push(child);
      }
    }
    // Remove the root itself — a caller is not its own descendant.
    descendants.delete(rootId);
    return descendants;
  }

  // ── private: target resolution + authorization ───────────────────────────

  /**
   * Resolve a target conversation id (full or short prefix) and authorize the
   * caller for `op`. Full ids are authorization-checked against the lineage
   * chain; short prefixes are resolved ONLY inside the authorized candidate set
   * (plan §7.3 — never leak non-authorized conversations).
   */
  async function resolveTarget(
    callerId: string,
    idInput: string,
    op: AccessOperation,
  ): Promise<Result<string>> {
    // Full id path: the exact id matches a known conversation.
    const meta = await store.getConversationMeta(idInput);
    if (meta !== null) {
      const isSelf = idInput === callerId;
      const isDescendant = isSelf ? false : await isDescendantOf(callerId, idInput);
      const access = decideAccess(op, { isSelf, isDescendant });
      if (!access.allowed) {
        return err("forbidden", access.reason ?? "target is not manageable by the caller");
      }
      return ok(idInput);
    }

    // Short-prefix path: resolve inside the authorized candidate set only.
    const descendants = await collectDescendants(callerId);
    const candidates =
      op === "read" || op === "open"
        ? [...descendants, callerId]
        : [...descendants];
    const res = resolveShortId(candidates, idInput);
    switch (res.kind) {
      case "too-short":
        return err(
          "invalid-input",
          `conversation id prefix must be at least 4 characters (got "${idInput}")`,
        );
      case "none":
        return err(
          "unknown-conversation",
          `no manageable conversation matches "${idInput}"`,
        );
      case "ambiguous":
        return err(
          "ambiguous-conversation",
          `multiple conversations match "${idInput}"`,
          res.candidates,
        );
      case "unique":
        return ok(res.id);
    }
  }

  // ── private: file reading + composition ──────────────────────────────────

  async function readFiles(
    files: readonly string[] | undefined,
    cwd: string | undefined,
  ): Promise<Result<{ path: string; content: string }[]>> {
    if (files === undefined || files.length === 0) return ok([]);
    const out: { path: string; content: string }[] = [];
    for (const path of files) {
      if (typeof path !== "string" || path.trim().length === 0) {
        return err("invalid-input", `file path must be a non-empty string (got "${String(path)}")`);
      }
      try {
        const content = await deps.readFileContent(path, cwd);
        out.push({ path, content });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err("invalid-input", `could not read file "${path}": ${msg}`);
      }
    }
    return ok(out);
  }

  // ── private: event-driven wait (plan §8.2) ───────────────────────────────

  /**
   * Wait for a target conversation's active turn to settle. Race-free: subscribe
   * BEFORE checking isActive (closes the race where a seal fires between the
   * check and the subscribe). Unsubscribes in every path (settled/timeout/abort).
   * Propagates the parent's AbortSignal to waiting only — never stops the child.
   */
  function waitForTurnSettled(
    orchestrator: SessionOrchestrator,
    conversationId: string,
    signal: AbortSignal | undefined,
    maxWaitMs: number,
  ): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsub: (() => void) | undefined;
      const onAbort = (): void => finish("aborted");
      const finish = (outcome: WaitOutcome): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        if (unsub !== undefined) unsub();
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onEvent = (event: AgentEvent): void => {
        if (event.type === "turn-sealed") finish("settled");
      };
      unsub = orchestrator.subscribe(conversationId, onEvent);
      // A seal may have fired synchronously during subscribe (fakes might).
      if (done) {
        if (unsub !== undefined) unsub();
        return;
      }
      if (signal?.aborted === true) {
        finish("aborted");
        return;
      }
      if (!orchestrator.isActive(conversationId)) {
        finish("settled");
        return;
      }
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish("timeout"), maxWaitMs);
    });
  }

  // ── private: load + extract a reply (thinking excluded) ──────────────────

  /**
   * After a turn settles (or immediately, when not waiting), load the
   * conversation and extract the last assistant text (thinking excluded). If
   * the reply is empty AND an error chunk is present, return a `child-turn-
   * failed` error (plan §8.5). Pure extraction lives in `pure.ts`.
   */
  async function loadReply(
    conversationId: string,
    maxChars: number,
  ): Promise<Result<{ reply: string; truncated: boolean }>> {
    let messages: ChatMessage[];
    try {
      messages = await store.load(conversationId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err("invalid-input", `failed to load conversation: ${msg}`);
    }
    const reply = extractLastAssistantReply(messages);
    if (reply.length === 0) {
      const errorText = extractLastError(messages);
      if (errorText !== undefined) {
        return err("child-turn-failed", errorText);
      }
    }
    const { text, truncated } = truncateText(reply, maxChars);
    return ok({ reply: text, truncated });
  }

  // ── private: open signal ─────────────────────────────────────────────────

  /** Resolve the persisted workspace and emit the `conversationOpened` hook
   * (owned by session-orchestrator; imported as the typed event symbol). */
  async function emitOpen(conversationId: string): Promise<string> {
    const workspaceId = await store.getWorkspaceId(conversationId);
    deps.emit(conversationOpened, { conversationId, workspaceId });
    return workspaceId;
  }

  // ── private: bounded status fetch ────────────────────────────────────────

  async function getStatus(conversationId: string): Promise<ConversationStatus> {
    const status = await store.getConversationStatus(conversationId);
    return status ?? "idle";
  }

  // ── listModels ───────────────────────────────────────────────────────────

  async function listModels(input: ListModelsInput): Promise<Result<ListModelsResult>> {
    if (input.callerConversationId === undefined || input.callerConversationId.length === 0) {
      return err("invalid-input", "caller conversation id is required");
    }
    const limit = clampLimit(input.limit, deps.defaultModelLimit, deps.maxModelLimit);

    let catalog: readonly string[];
    try {
      catalog = await deps.credentialStore.listCatalog();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err("invalid-input", `failed to read model catalog: ${msg}`);
    }

    // Build entries with per-model metadata (vision is authoritative-then-
    // heuristic). Fetching ModelInfo per model is the catalog-failure surface.
    const entries: ModelEntry[] = [];
    for (const name of catalog) {
      let info;
      try {
        info = await deps.credentialStore.getModelInfo(name);
      } catch {
        info = undefined;
      }
      const entry: ModelEntry = {
        name,
        ...(info?.displayName !== undefined ? { displayName: info.displayName } : {}),
        ...(info?.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
        vision: resolveVision(name, info),
      };
      entries.push(entry);
    }

    const filtered = filterModelEntries(entries, {
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.vision !== undefined ? { vision: input.vision } : {}),
      limit,
    });
    log.debug("agent-management.list", { callerId: input.callerConversationId, count: filtered.length });
    return ok({ models: filtered });
  }

  // ── summon ───────────────────────────────────────────────────────────────

  async function summon(input: SummonAgentInput): Promise<Result<SummonAgentResult>> {
    const callerId = input.callerConversationId;
    if (callerId === undefined || callerId.length === 0) {
      return err("invalid-input", "caller conversation id is required");
    }
    if (typeof input.model !== "string" || input.model.trim().length === 0) {
      return err("invalid-input", "'model' is required and must be a non-empty string");
    }
    if (typeof input.task !== "string" || input.task.trim().length === 0) {
      return err("invalid-input", "'task' is required and must be a non-empty string");
    }
    const toolAccess = parseToolAccess(input.toolAccess);
    if ("error" in toolAccess) return err("invalid-input", toolAccess.error);
    const accessMode = toolAccess.mode;

    const orchestrator = requireOrchestrator();
    if (orchestrator === undefined) {
      return err("invalid-input", "session-orchestrator is not available");
    }

    // Validate the model is an exact catalog name (plan §6.2).
    let catalog: readonly string[];
    try {
      catalog = await deps.credentialStore.listCatalog();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err("invalid-input", `failed to read model catalog: ${msg}`);
    }
    if (!catalog.includes(input.model)) {
      return err("unknown-model", `unknown model "${input.model}"; use list_agent_models to discover valid names`);
    }

    // Resolve caller context (plan §5 step 2).
    const callerWorkspace = await store.getWorkspaceId(callerId);
    const callerCwd = await store.getEffectiveCwd(callerId);
    const callerComputer = await store.getEffectiveComputer(callerId);

    // Workspace override must reference an EXISTING workspace (plan §7.2).
    let workspaceId = callerWorkspace;
    if (input.workspaceId !== undefined) {
      const ws = await store.getWorkspace(input.workspaceId);
      if (ws === null) {
        return err("workspace-not-found", `workspace "${input.workspaceId}" does not exist`);
      }
      workspaceId = input.workspaceId;
    }

    // Effective child cwd/computer inherit the caller's (plan §6.2).
    const cwd = input.cwd ?? (callerCwd ?? undefined);
    const computerId = input.computerId ?? (callerComputer ?? undefined);

    // Compose file attachments (resolve against the child's effective cwd).
    const filesResult = await readFiles(input.files, cwd);
    if (!filesResult.ok) return filesResult;
    const composedText = formatFileAttachments(input.task, filesResult.value);

    // Tool policy from toolAccess (default "all"; "none" for vision isolation).
    const toolPolicy: ConversationToolPolicy =
      accessMode === "none" ? { mode: "none" } : { mode: "all" };

    // Plan §5 step 1: generate a fresh conversation id.
    const conversationId = deps.generateId();

    // Plan §5 step 3: persist lineage + policy BEFORE startTurn (separate keys,
    // never pre-create the meta row) so the first turn's tool filter sees them.
    await store.setParentConversationId(conversationId, callerId);
    await store.setToolPolicy(conversationId, toolPolicy);

    // Plan §5 step 4: call startTurn (orchestrator re-stamps lineage + policy
    // idempotently and runs new-conversation workspace/title/system-prompt setup).
    const startInput: StartTurnInput = {
      conversationId,
      text: composedText,
      modelName: input.model,
      workspaceId,
      parentConversationId: callerId,
      toolPolicy,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(computerId !== undefined ? { computerId } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.title !== undefined && input.title.trim().length > 0 ? { title: input.title.trim() } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.images !== undefined ? { images: input.images } : {}),
    };
    const startResult = orchestrator.startTurn(startInput);
    const started = startResult.started;
    log.info("agent-management.summon", {
      callerId,
      childId: conversationId,
      model: input.model,
      workspaceId,
      started,
      wait: input.wait === true,
      open: input.open !== false,
    });

    // Open the new conversation in connected frontends (default true).
    if (input.open !== false) {
      await emitOpen(conversationId);
    }

    const status = await getStatus(conversationId);

    // Non-blocking by default (plan §8.1).
    if (input.wait !== true) {
      return ok({
        conversationId,
        workspaceId,
        status,
        started,
      });
    }

    // Blocking: wait for the child's first turn to settle.
    const outcome = await waitForTurnSettled(orchestrator, conversationId, input.signal, deps.maxWaitMs);
    const finalStatus = await getStatus(conversationId);
    if (outcome === "timeout") {
      return ok({ conversationId, workspaceId, status: finalStatus, started, waitTimeout: true });
    }
    if (outcome === "aborted") {
      return ok({ conversationId, workspaceId, status: finalStatus, started, waitCancelled: true });
    }
    const replyResult = await loadReply(conversationId, deps.defaultReadChars);
    if (!replyResult.ok) {
      // child-turn-failed: keep the conversation id in a success shell.
      return ok({ conversationId, workspaceId, status: finalStatus, started, reply: "", truncated: false });
    }
    return ok({
      conversationId,
      workspaceId,
      status: finalStatus,
      started,
      reply: replyResult.value.reply,
      ...(replyResult.value.truncated ? { truncated: true } : {}),
    });
  }

  // ── list ─────────────────────────────────────────────────────────────────

  async function list(input: ListAgentsInput): Promise<Result<ListAgentsResult>> {
    const callerId = input.callerConversationId;
    if (callerId === undefined || callerId.length === 0) {
      return err("invalid-input", "caller conversation id is required");
    }
    const relationship = input.relationship ?? "children";
    const limit = clampLimit(input.limit, deps.defaultListLimit, deps.maxListLimit);
    const statusFilter = input.status;

    // Gather candidate metadata by relationship.
    let metas: ConversationMeta[];
    let descendantSet: Set<string>;
    if (relationship === "workspace") {
      const wsId = input.workspaceId ?? (await store.getWorkspaceId(callerId));
      // Validate an explicit workspace override exists (plan §7.2).
      if (input.workspaceId !== undefined) {
        const ws = await store.getWorkspace(input.workspaceId);
        if (ws === null) {
          return err("workspace-not-found", `workspace "${input.workspaceId}" does not exist`);
        }
      }
      metas = [
        ...(await store.listConversations({
          workspaceId: wsId,
          ...(statusFilter !== undefined ? { status: statusFilter } : {}),
        })),
      ];
      descendantSet = await collectDescendants(callerId);
    } else {
      // children / descendants — lineage-based, across any workspace.
      descendantSet = await collectDescendants(callerId);
      let ids: string[];
      if (relationship === "children") {
        ids = await store.listChildren(callerId);
      } else {
        ids = [...descendantSet];
      }
      const fetched: ConversationMeta[] = [];
      for (const id of ids) {
        const m = await store.getConversationMeta(id);
        if (m !== null) fetched.push(m);
      }
      metas = sortByActivityDesc(fetched);
      metas = filterByStatus(metas, statusFilter);
    }

    // Apply query + activity sort + bound (workspace path already sorted by
    // the store; re-sort for a stable newest-first ordering).
    metas = sortByActivityDesc(filterByQuery(metas, input.query));

    const total = metas.length;
    const truncated = total > limit;
    const page = metas.slice(0, limit);

    // Build entries: fetch model + parent per conversation (bounded by limit).
    const agents: AgentEntry[] = [];
    for (const m of page) {
      const model = await store.getModel(m.id);
      const parent = await store.getParentConversationId(m.id);
      const manageable = descendantSet.has(m.id);
      agents.push(toAgentEntry(m, model, parent, manageable));
    }

    log.debug("agent-management.list", {
      callerId,
      relationship,
      count: agents.length,
      truncated,
    });
    return ok({ agents, truncated });
  }

  // ── read ─────────────────────────────────────────────────────────────────

  async function read(input: ReadAgentInput): Promise<Result<ReadAgentResult>> {
    const callerId = input.callerConversationId;
    if (callerId === undefined || callerId.length === 0) {
      return err("invalid-input", "caller conversation id is required");
    }
    if (typeof input.conversationId !== "string" || input.conversationId.length === 0) {
      return err("invalid-input", "'conversationId' is required");
    }
    const maxChars = clampLimit(input.maxChars, deps.defaultReadChars, deps.maxReadChars);

    const target = await resolveTarget(callerId, input.conversationId, "read");
    if (!target.ok) return target;
    const conversationId = target.value;

    const orchestrator = requireOrchestrator();

    // Wait for an active turn to settle (plan §6.4 / §8.2).
    if (input.wait === true) {
      if (orchestrator === undefined) {
        return err("invalid-input", "session-orchestrator is not available");
      }
      const outcome = await waitForTurnSettled(
        orchestrator,
        conversationId,
        input.signal,
        deps.maxWaitMs,
      );
      const status = await getStatus(conversationId);
      if (outcome === "timeout") {
        const replyResult = await loadReply(conversationId, maxChars);
        const reply = replyResult.ok ? replyResult.value.reply : "";
        const truncated = replyResult.ok ? replyResult.value.truncated : false;
        return ok({ conversationId, status, reply, truncated, waitTimeout: true });
      }
      if (outcome === "aborted") {
        const replyResult = await loadReply(conversationId, maxChars);
        const reply = replyResult.ok ? replyResult.value.reply : "";
        const truncated = replyResult.ok ? replyResult.value.truncated : false;
        return ok({ conversationId, status, reply, truncated, waitCancelled: true });
      }
    }

    const status = await getStatus(conversationId);
    const replyResult = await loadReply(conversationId, maxChars);
    if (!replyResult.ok) return replyResult;
    return ok({
      conversationId,
      status,
      reply: replyResult.value.reply,
      truncated: replyResult.value.truncated,
    });
  }

  // ── send ─────────────────────────────────────────────────────────────────

  async function send(input: SendAgentInput): Promise<Result<SendAgentResult>> {
    const callerId = input.callerConversationId;
    if (callerId === undefined || callerId.length === 0) {
      return err("invalid-input", "caller conversation id is required");
    }
    if (typeof input.conversationId !== "string" || input.conversationId.length === 0) {
      return err("invalid-input", "'conversationId' is required");
    }
    if (typeof input.message !== "string" || input.message.trim().length === 0) {
      return err("invalid-input", "'message' is required and must be a non-empty string");
    }

    const target = await resolveTarget(callerId, input.conversationId, "mutate");
    if (!target.ok) return target;
    const conversationId = target.value;

    const orchestrator = requireOrchestrator();
    if (orchestrator === undefined) {
      return err("invalid-input", "session-orchestrator is not available");
    }

    // Resolve files against the TARGET's effective cwd (its persisted context
    // remains authoritative — plan §6.5).
    const targetCwd = await store.getEffectiveCwd(conversationId);
    const filesResult = await readFiles(input.files, targetCwd ?? undefined);
    if (!filesResult.ok) return filesResult;
    const composedText = formatFileAttachments(input.message.trim(), filesResult.value);

    // enqueue owns the idle→startTurn vs active→queue decision (no delivery
    // parameter — plan §6.5). The target's persisted workspace/model/computer
    // remain authoritative (no workspaceId override passed).
    const enqueueResult = orchestrator.enqueue({ conversationId, text: composedText });
    log.info("agent-management.send", {
      callerId,
      targetId: conversationId,
      delivered: enqueueResult.startedTurn ? "started-turn" : "queued",
      wait: input.wait === true,
    });

    if (!enqueueResult.startedTurn) {
      // Active target → message queued (or dropped when no queue extension).
      const queue: readonly QueuedMessage[] = enqueueResult.queue;
      if (queue.length === 0) {
        return err(
          "queue-unavailable",
          "the message-queue is not available and the target conversation is active; the message was dropped",
        );
      }
      // Reject wait:true on a queued message (plan §6.5).
      if (input.wait === true) {
        return err(
          "invalid-input",
          "wait: true is not supported when the message is queued (target was active); use read_agent after delivery",
        );
      }
      const last = queue[queue.length - 1];
      const messageId = last?.id;
      if (input.open === true) await emitOpen(conversationId);
      return ok({
        conversationId,
        delivered: "queued",
        ...(messageId !== undefined ? { messageId } : {}),
      });
    }

    // Idle target → a new turn started.
    if (input.open === true) await emitOpen(conversationId);
    if (input.wait !== true) {
      return ok({ conversationId, delivered: "started-turn" });
    }
    const outcome = await waitForTurnSettled(
      orchestrator,
      conversationId,
      input.signal,
      deps.maxWaitMs,
    );
    if (outcome === "timeout") {
      return ok({ conversationId, delivered: "started-turn", waitTimeout: true });
    }
    if (outcome === "aborted") {
      return ok({ conversationId, delivered: "started-turn", waitCancelled: true });
    }
    const replyResult = await loadReply(conversationId, deps.defaultReadChars);
    if (!replyResult.ok) {
      return ok({ conversationId, delivered: "started-turn", reply: "", truncated: false });
    }
    return ok({
      conversationId,
      delivered: "started-turn",
      reply: replyResult.value.reply,
      ...(replyResult.value.truncated ? { truncated: true } : {}),
    });
  }

  // ── cancelMessage ────────────────────────────────────────────────────────

  async function cancelMessage(
    input: CancelAgentMessageInput,
  ): Promise<Result<CancelAgentMessageResult>> {
    const callerId = input.callerConversationId;
    if (callerId === undefined || callerId.length === 0) {
      return err("invalid-input", "caller conversation id is required");
    }
    if (typeof input.conversationId !== "string" || input.conversationId.length === 0) {
      return err("invalid-input", "'conversationId' is required");
    }
    if (typeof input.messageId !== "string" || input.messageId.length === 0) {
      return err("invalid-input", "'messageId' is required");
    }

    const target = await resolveTarget(callerId, input.conversationId, "mutate");
    if (!target.ok) return target;
    const conversationId = target.value;

    const orchestrator = requireOrchestrator();
    if (orchestrator === undefined) {
      return err("invalid-input", "session-orchestrator is not available");
    }

    // Delegates to the existing message-queue cancellation contract; idempotent
    // (plan §6.6): cancelled:false when already delivered/cancelled/unknown.
    const result = orchestrator.cancelQueuedMessage({
      conversationId,
      messageId: input.messageId,
    });
    log.debug("agent-management.cancel", {
      callerId,
      targetId: conversationId,
      cancelled: result.cancelled,
      queueLen: result.queue.length,
    });
    return ok({
      conversationId,
      cancelled: result.cancelled,
      queueLength: result.queue.length,
    });
  }

  // ── open ─────────────────────────────────────────────────────────────────

  async function open(input: OpenAgentInput): Promise<Result<OpenAgentResult>> {
    const callerId = input.callerConversationId;
    if (callerId === undefined || callerId.length === 0) {
      return err("invalid-input", "caller conversation id is required");
    }
    if (typeof input.conversationId !== "string" || input.conversationId.length === 0) {
      return err("invalid-input", "'conversationId' is required");
    }

    const target = await resolveTarget(callerId, input.conversationId, "open");
    if (!target.ok) return target;
    const conversationId = target.value;

    const workspaceId = await emitOpen(conversationId);
    log.debug("agent-management.open", { callerId, targetId: conversationId, workspaceId });
    return ok({ conversationId, workspaceId });
  }

  return {
    listModels,
    summon,
    list,
    read,
    send,
    cancelMessage,
    open,
  };
}

// Re-export the inputs/outputs/types consumers need alongside the factory.
export type {
  AgentManagementService,
  CancelAgentMessageInput,
  CancelAgentMessageResult,
  ListAgentsInput,
  ListAgentsResult,
  ListModelsInput,
  ListModelsResult,
  OpenAgentInput,
  OpenAgentResult,
  ReadAgentInput,
  ReadAgentResult,
  SendAgentInput,
  SendAgentResult,
  SummonAgentInput,
  SummonAgentResult,
  Result,
};
