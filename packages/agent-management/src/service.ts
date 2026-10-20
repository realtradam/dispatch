/**
 * AgentManagementService — the imperative shell that wires injected stores +
 * the session-orchestrator to the pure decision logic in `pure.ts` (plan P2).
 *
 * Effects (conversation-store, credential-store, named-agents registry,
 * orchestrator, filesystem, event-bus) are injected via
 * {@link AgentManagementDeps}; decision logic is pure. The service is useful
 * independently of the AI tools — `vision-handoff` calls `summon` with a
 * restricted tool policy, and tests inject fakes.
 *
 * `list_agent_models` reads ONLY from the named-agents registry (plan §8.1) —
 * ZERO provider-catalog calls. `summon` selects by `agent` (a Named Agent,
 * resolved locally, snapshotted onto the conversation — plan §8.2/§7) XOR by
 * the backward-compatible raw `model` (catalog-validated, plan §13).
 *
 * Summon algorithm (plan §5) — executed in this exact order:
 *  1. Resolve the effective model: `agent` (named-agents registry, no catalog)
 *     or `model` (raw, catalog-validated). Exactly one is required.
 *  2. Generate a new conversationId (UUID).
 *  3. Resolve the caller's effective workspace, working directory, computer.
 *  4. Persist `parentConversationId` + `toolPolicy` (+ the Named Agent
 *     selection snapshot, when summoning by `agent`) BEFORE calling startTurn
 *     (separate store keys — never pre-create the meta row) so the first turn's
 *     tool-assembly filter chain sees the policy and the conversation carries
 *     its frozen selection.
 *  5. Call `orchestrator.startTurn(...)` (the orchestrator re-stamps lineage +
 *     policy idempotently and handles new-conversation workspace/title/system-
 *     prompt setup).
 *  6. Return the conversation id, workspace, status, and started flag.
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
import type { NamedAgentsService } from "@dispatch/named-agents";
import type { SessionOrchestrator, StartTurnInput } from "@dispatch/session-orchestrator";
import { conversationOpened } from "@dispatch/session-orchestrator";
import type { NamedAgent, NamedAgentSelectionSnapshot, QueuedMessage } from "@dispatch/wire";
import type {
  AgentEntry,
  AgentManagementService,
  CancelAgentMessageInput,
  CancelAgentMessageResult,
  ListAgentsInput,
  ListAgentsResult,
  ListModelsInput,
  ListModelsResult,
  NamedAgentEntry,
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
  type AccessOperation,
  clampLimit,
  decideAccess,
  extractLastAssistantReply,
  extractLastError,
  filterByQuery,
  filterByStatus,
  filterNamedAgentEntries,
  formatFileAttachments,
  parseToolAccess,
  resolveShortId,
  sortByActivityDesc,
  toAgentEntry,
  truncateText,
} from "./pure.js";

// ─── Dependencies (all injected — no ambient state) ─────────────────────────

export interface AgentManagementDeps {
  readonly conversationStore: ConversationStore;
  readonly credentialStore: CredentialStore;
  /**
   * The Named Agent registry (plan §10.1). `list_agent_models` reads from
   * `list()` and `summon_agent` resolves an `agent` reference via `resolve()`
   * — both with ZERO provider-catalog calls (plan §10.2). The raw `model`
   * summon path still uses `credentialStore` for catalog validation.
   */
  readonly namedAgents: NamedAgentsService;
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

export type WaitOutcome = "settled" | "timeout" | "aborted" | { readonly error: string };

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
   * caller for read/open ONLY. Messaging uses a separate global resolver so its
   * wider scope cannot widen non-messaging operations. Full ids are checked
   * against lineage; short prefixes use only descendants and self.
   */
  async function resolveTarget(
    callerId: string,
    idInput: string,
    op: Exclude<AccessOperation, "mutate">,
  ): Promise<Result<string>> {
    // Full id path: the exact id matches a known conversation.
    const meta = await store.getConversationMeta(idInput);
    if (meta !== null) {
      const isSelf = idInput === callerId;
      const isDescendant = isSelf ? false : await isDescendantOf(callerId, idInput);
      const access = decideAccess(op, { isSelf, isDescendant });
      if (!access.allowed) {
        return err("forbidden", access.reason ?? "target is outside the caller's read/open scope");
      }
      return ok(idInput);
    }

    // Short-prefix path: resolve inside the authorized candidate set only.
    const descendants = await collectDescendants(callerId);
    const candidates = [...descendants, callerId];
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
          `no readable/openable conversation matches "${idInput}"`,
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

  /** Resolve messaging targets globally, with no lineage/workspace/status filter. */
  async function resolveMessagingTarget(
    callerId: string,
    idInput: string,
  ): Promise<Result<string>> {
    const meta = await store.getConversationMeta(idInput);
    let targetId = idInput;
    if (meta === null) {
      const candidates = (await store.listConversations()).map((conversation) => conversation.id);
      const resolution = resolveShortId(candidates, idInput);
      switch (resolution.kind) {
        case "too-short":
          return err(
            "invalid-input",
            `conversation id prefix must be at least 4 characters (got "${idInput}")`,
          );
        case "none":
          return err("unknown-conversation", `no existing conversation matches "${idInput}"`);
        case "ambiguous":
          return err(
            "ambiguous-conversation",
            `multiple conversations match "${idInput}"`,
            resolution.candidates,
          );
        case "unique":
          targetId = resolution.id;
      }
    }
    const access = decideAccess("mutate", {
      isSelf: targetId === callerId,
      isDescendant: false,
    });
    if (!access.allowed) return err("forbidden", access.reason ?? "cannot message yourself");
    return ok(targetId);
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
   * BEFORE checking isActive (closes the race where a terminal event fires between the
   * check and the subscribe). Unsubscribes in every path (settled/timeout/abort).
   * Propagates the caller's AbortSignal to waiting only — never stops the target.
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
      let lastError: string | undefined;
      const onEvent = (event: AgentEvent): void => {
        if (event.type === "error") lastError = event.message;
        if (event.type === "turn-ended") {
          finish(
            event.reason === "error" || event.reason === "rejected"
              ? { error: lastError ?? `child turn ${event.reason}` }
              : "settled",
          );
        }
      };
      unsub = orchestrator.subscribe(conversationId, onEvent);
      // A terminal event may have fired synchronously during subscribe (fakes might).
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
  async function emitOpen(conversationId: string, knownWorkspaceId?: string): Promise<string> {
    // Prefer the caller-supplied (already-resolved) workspace when provided.
    // This avoids the race where a freshly-summoned conversation's workspace
    // has not yet been persisted by startTurn's detached workspace setup —
    // reading getWorkspaceId() at that instant returns the "default" fallback
    // and broadcasts the wrong workspace, which stamps the frontend tab under
    // "default". Existing/ordinary conversations pass no known workspace, so
    // we still resolve from the store (correct for already-persisted metadata).
    const workspaceId = knownWorkspaceId ?? (await store.getWorkspaceId(conversationId));
    const model = await store.getModel(conversationId);
    const tabGroupParentId = await store.getTabGroupParentId(conversationId);
    deps.emit(conversationOpened, {
      conversationId,
      workspaceId,
      ...(model !== null ? { model } : {}),
      ...(tabGroupParentId !== null ? { tabGroupParentId } : {}),
    });
    return workspaceId;
  }

  // ── private: bounded status fetch ────────────────────────────────────────

  async function getStatus(conversationId: string): Promise<ConversationStatus> {
    const status = await store.getConversationStatus(conversationId);
    return status ?? "idle";
  }

  // ── listModels ───────────────────────────────────────────────────────────
  //
  // Lists ONLY the locally configured Named Agents (plan §8.1) — ZERO
  // provider-catalog calls. The small local registry list is filtered in
  // memory by a case-insensitive name substring (`query`) and bounded by
  // `limit`. Vision filtering is intentionally omitted (no local metadata
  // supports it; reintroducing it would require the slow catalog scan).

  async function listModels(input: ListModelsInput): Promise<Result<ListModelsResult>> {
    if (input.callerConversationId === undefined || input.callerConversationId.length === 0) {
      return err("invalid-input", "caller conversation id is required");
    }
    const limit = clampLimit(input.limit, deps.defaultModelLimit, deps.maxModelLimit);

    let agents: readonly NamedAgent[];
    try {
      agents = await deps.namedAgents.list();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err("invalid-input", `failed to read named agents: ${msg}`);
    }

    // The registry returns records in deterministic case-insensitive name order;
    // preserve it. Build the Named-Agent-oriented entries the tool exposes.
    const entries: NamedAgentEntry[] = agents.map((a) => ({
      namedAgentId: a.id,
      name: a.name,
      model: a.model,
    }));

    const filtered = filterNamedAgentEntries(entries, {
      ...(input.query !== undefined ? { query: input.query } : {}),
      limit,
    });
    log.debug("agent-management.listModels", {
      callerId: input.callerConversationId,
      count: filtered.length,
    });
    return ok({ models: filtered });
  }

  // ── summon ───────────────────────────────────────────────────────────────

  async function summon(input: SummonAgentInput): Promise<Result<SummonAgentResult>> {
    const callerId = input.callerConversationId;
    if (callerId === undefined || callerId.length === 0) {
      return err("invalid-input", "caller conversation id is required");
    }
    if (typeof input.task !== "string" || input.task.trim().length === 0) {
      return err("invalid-input", "'task' is required and must be a non-empty string");
    }
    const toolAccess = parseToolAccess(input.toolAccess);
    if ("error" in toolAccess) return err("invalid-input", toolAccess.error);
    const accessMode = toolAccess.mode;

    // Exactly one effective selection is required (plan §8.2 step 7): a Named
    // Agent (`agent`) XOR a raw model (`model`). Whitespace-only / undefined
    // counts as "not supplied". Both or neither → invalid-input.
    const hasAgent = typeof input.agent === "string" && input.agent.trim().length > 0;
    const hasModel = typeof input.model === "string" && input.model.trim().length > 0;
    if (hasAgent && hasModel) {
      return err(
        "invalid-input",
        "provide exactly one of 'agent' (a named agent name/id) or 'model' (a raw <credential>/<model>) — not both",
      );
    }
    if (!hasAgent && !hasModel) {
      return err(
        "invalid-input",
        "provide exactly one of 'agent' (a named agent name/id) or 'model' (a raw <credential>/<model>); call list_agent_models to discover named agents",
      );
    }

    const orchestrator = requireOrchestrator();
    if (orchestrator === undefined) {
      return err("invalid-input", "session-orchestrator is not available");
    }

    // Resolve the effective conversation model. The two paths are mutually
    // exclusive (validated above):
    //  - `agent` (Named Agent): resolve locally via the registry; use the
    //    Named Agent's configured raw model. NO catalog validation (plan §8.2
    //    step 3 / §10.2 / §16). A missing Named Agent → `unknown-agent` with
    //    the locally available names (plan §8.2 step 5). The selection snapshot
    //    is frozen onto the conversation after we generate its id.
    //  - `model` (raw): keep the EXISTING path exactly, including catalog
    //    validation → `unknown-model` (plan §8.2 step 6 / §13). No snapshot.
    let effectiveModel: string;
    let namedSnapshot: NamedAgentSelectionSnapshot | undefined;
    if (hasAgent) {
      const ref = input.agent as string;
      let resolved: NamedAgent | null;
      try {
        resolved = await deps.namedAgents.resolve(ref);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err("invalid-input", `failed to resolve named agent "${ref}": ${msg}`);
      }
      if (resolved === null) {
        let available: readonly NamedAgent[] = [];
        try {
          available = await deps.namedAgents.list();
        } catch {
          available = [];
        }
        const names = available.map((a) => a.name).join(", ");
        return err(
          "unknown-agent",
          names.length > 0
            ? `unknown named agent "${ref}"; available named agents: ${names}`
            : `unknown named agent "${ref}"; no named agents are configured (ask the user to add one in the Named Agents sidebar view)`,
        );
      }
      effectiveModel = resolved.model;
      namedSnapshot = {
        namedAgentId: resolved.id,
        namedAgentName: resolved.name,
        model: resolved.model,
      };
    } else {
      // Raw-model path: validate the model is an exact catalog name (plan §6.2).
      const rawModel = (input.model as string).trim();
      let catalog: readonly string[];
      try {
        catalog = await deps.credentialStore.listCatalog();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err("invalid-input", `failed to read model catalog: ${msg}`);
      }
      if (!catalog.includes(rawModel)) {
        return err(
          "unknown-model",
          `unknown model "${rawModel}"; use list_agent_models to discover named agents`,
        );
      }
      effectiveModel = rawModel;
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
    const cwd = input.cwd ?? callerCwd ?? undefined;
    const computerId = input.computerId ?? callerComputer ?? undefined;

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

    // Freeze the Named Agent selection snapshot onto the conversation BEFORE
    // startTurn (plan §7) — mirrors the lineage + policy persistence above. The
    // snapshot is independent of the registry record, so later edits/deletes of
    // the Named Agent never mutate this conversation. Omitted on the raw-model
    // path (a raw-model conversation carries no snapshot).
    if (namedSnapshot !== undefined) {
      await store.setNamedAgentSelection(conversationId, namedSnapshot);
    }

    // Plan §5 step 4: call startTurn (orchestrator re-stamps lineage + policy
    // idempotently and runs new-conversation workspace/title/system-prompt setup).
    const startInput: StartTurnInput = {
      conversationId,
      text: composedText,
      modelName: effectiveModel,
      workspaceId,
      parentConversationId: callerId,
      toolPolicy,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(computerId !== undefined ? { computerId } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.title !== undefined && input.title.trim().length > 0
        ? { title: input.title.trim() }
        : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.images !== undefined ? { images: input.images } : {}),
    };
    const startResult = orchestrator.startTurn(startInput);
    const started = startResult.started;
    const waiting =
      input.wait === true
        ? waitForTurnSettled(orchestrator, conversationId, input.signal, deps.maxWaitMs)
        : undefined;
    log.info("agent-management.summon", {
      callerId,
      childId: conversationId,
      model: effectiveModel,
      ...(namedSnapshot !== undefined ? { namedAgent: namedSnapshot.namedAgentName } : {}),
      workspaceId,
      started,
      wait: input.wait === true,
      open: input.open !== false,
    });

    // Open the new conversation in connected frontends (default true).
    // Pass the already-resolved intended workspace so the conversation.open
    // signal carries the correct workspace even before startTurn's detached
    // workspace setup persists it (avoids the "tab lands in default" race).
    if (input.open !== false) {
      await emitOpen(conversationId, workspaceId);
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
    const outcome = await waiting;
    if (typeof outcome === "object") return err("child-turn-failed", outcome.error);
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
      return ok({
        conversationId,
        workspaceId,
        status: finalStatus,
        started,
        reply: "",
        truncated: false,
      });
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
      if (typeof outcome === "object") return err("child-turn-failed", outcome.error);
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

    const target = await resolveMessagingTarget(callerId, input.conversationId);
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
          "wait: true is not supported when the message is queued (target was active); after delivery, use read_agent only if the target is within your separate read scope (descendants and self)",
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

    // Subscribe before any open-signal I/O can let the new turn finish.
    const waiting =
      input.wait === true
        ? waitForTurnSettled(orchestrator, conversationId, input.signal, deps.maxWaitMs)
        : undefined;
    // Idle target → a new turn started.
    if (input.open === true) await emitOpen(conversationId);
    if (input.wait !== true) {
      return ok({ conversationId, delivered: "started-turn" });
    }
    const outcome = await waiting;
    if (typeof outcome === "object") return err("child-turn-failed", outcome.error);
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

    const target = await resolveMessagingTarget(callerId, input.conversationId);
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
  NamedAgentEntry,
  OpenAgentInput,
  OpenAgentResult,
  ReadAgentInput,
  ReadAgentResult,
  Result,
  SendAgentInput,
  SendAgentResult,
  SummonAgentInput,
  SummonAgentResult,
};
