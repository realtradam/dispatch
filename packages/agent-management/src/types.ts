/**
 * Agent-management service contract — the typed surface both the AI tools and
 * programmatic consumers (e.g. `vision-handoff`) call.
 *
 * Every input carries an explicit `callerConversationId` that the tool
 * implementation supplies from `ToolExecuteContext` (never from model-provided
 * arguments), so a caller cannot forge its identity. The service resolves
 * caller context and enforces lineage-based access (plan §7).
 *
 * The `summon` method's input is WIDER than the `summon_agent` AI tool schema:
 * it accepts `systemPrompt` and `images` (service-level fields for
 * programmatic callers like `vision-handoff`) that are NOT exposed to models.
 */

import type {
  ConversationStatus,
  ConversationToolPolicy,
  EventHookDescriptor,
  ImageInput,
  ReasoningEffort,
  ServiceHandle,
} from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";

// ─── Error taxonomy (plan §8.5) ─────────────────────────────────────────────

export type AgentManagementErrorCode =
  | "invalid-input"
  | "unknown-conversation"
  | "ambiguous-conversation"
  | "forbidden"
  | "unknown-model"
  | "unknown-agent"
  | "workspace-not-found"
  | "queue-unavailable"
  | "wait-timeout"
  | "caller-cancelled"
  | "child-turn-failed";

export interface AgentManagementError {
  readonly code: AgentManagementErrorCode;
  readonly message: string;
  /** Candidate full IDs, present only for `ambiguous-conversation`. */
  readonly candidates?: readonly string[];
}

/** A service call result: either a success value or a typed error. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentManagementError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(
  code: AgentManagementErrorCode,
  message: string,
  candidates?: readonly string[],
): Result<never> {
  return {
    ok: false,
    error: { code, message, ...(candidates !== undefined ? { candidates } : {}) },
  };
}

// ─── list_agent_models ──────────────────────────────────────────────────────
//
// `list_agent_models` returns ONLY the locally configured Named Agents
// (plan §8.1) — never the raw provider catalog. Zero catalog calls on this
// path; the small local list is filtered in-memory by name substring + a
// bounded limit. Vision filtering is intentionally omitted: no local
// metadata supports it, and reintroducing it would require the slow catalog
// scan the Named Agent path exists to avoid (plan §8.1).

export interface ListModelsInput {
  readonly callerConversationId: string;
  readonly query?: string;
  readonly limit?: number;
}

/**
 * A Named Agent entry in `list_agent_models` output — the curated presets
 * available for `summon_agent`. `model` is the resolved canonical
 * `<credential>/<model>` the Named Agent is bound to (what a raw-model caller
 * would pass to summon). Pass the `name` (or `namedAgentId`) to `summon_agent`
 * as `agent`; do not guess raw provider/model identifiers.
 */
export interface NamedAgentEntry {
  /** Stable id of the Named Agent — also accepted by `summon_agent` as `agent`. */
  readonly namedAgentId: string;
  /** Friendly name — also accepted by `summon_agent` as `agent`. */
  readonly name: string;
  /** Resolved canonical `<credential>/<model>` the Named Agent is bound to. */
  readonly model: string;
}

export interface ListModelsResult {
  readonly models: readonly NamedAgentEntry[];
}

// ─── summon_agent ───────────────────────────────────────────────────────────

export interface SummonAgentInput {
  readonly callerConversationId: string;
  /**
   * A Named Agent name or stable id, resolved locally to its configured raw
   * model (plan §8.2). When supplied, the Named Agent's resolved `model` is
   * used for the subagent and a {@link NamedAgentSelectionSnapshot} is frozen
   * onto the conversation. Exactly one of `agent` / `model` must be supplied
   * — both or neither is an `invalid-input` error.
   */
  readonly agent?: string;
  /**
   * Backward-compatible raw-model escape hatch (plan §13): the exact
   * `<credential>/<model>` validated against the provider catalog. When
   * supplied (and `agent` is not), the existing raw-model path runs,
   * including catalog validation → `unknown-model`. No snapshot is written.
   */
  readonly model?: string;
  readonly task: string;
  readonly files?: readonly string[];
  readonly cwd?: string;
  readonly workspaceId?: string;
  readonly computerId?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly title?: string;
  readonly wait?: boolean;
  readonly open?: boolean;
  readonly toolAccess?: "all" | "none";
  /**
   * Service-level only (NOT in the `summon_agent` tool schema): an explicit
   * system-prompt override. Used by `vision-handoff` for focused consultations.
   */
  readonly systemPrompt?: string;
  /**
   * Service-level only (NOT in the tool schema): image attachments for vision
   * consultations. Consumed by `vision-handoff`, not AI-callable.
   */
  readonly images?: readonly ImageInput[];
  /** Parent tool's abort signal — propagated to waiting only. */
  readonly signal?: AbortSignal;
}

export interface SummonAgentResult {
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly status: ConversationStatus;
  readonly started: boolean;
  /** Final assistant text, present when `wait: true` and the turn settled. */
  readonly reply?: string;
  /** Whether `reply` was truncated to the char cap. */
  readonly truncated?: boolean;
  /** Wait was ended by timeout (the child is still running). */
  readonly waitTimeout?: boolean;
  /** Wait was ended by the parent's abort (the child is still running). */
  readonly waitCancelled?: boolean;
}

// ─── list_agents ────────────────────────────────────────────────────────────

export interface ListAgentsInput {
  readonly callerConversationId: string;
  readonly workspaceId?: string;
  readonly status?: readonly ConversationStatus[];
  readonly relationship?: "children" | "descendants" | "workspace";
  readonly query?: string;
  readonly limit?: number;
}

export interface AgentEntry {
  readonly conversationId: string;
  readonly shortId: string;
  readonly title: string;
  readonly model?: string;
  readonly status: ConversationStatus;
  readonly workspaceId: string;
  readonly parentConversationId?: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  /** Whether the caller may MUTATE this conversation (descendant). */
  readonly manageable: boolean;
}

export interface ListAgentsResult {
  readonly agents: readonly AgentEntry[];
  readonly truncated: boolean;
}

// ─── read_agent ─────────────────────────────────────────────────────────────

export interface ReadAgentInput {
  readonly callerConversationId: string;
  readonly conversationId: string;
  readonly wait?: boolean;
  readonly maxChars?: number;
  readonly signal?: AbortSignal;
}

export interface ReadAgentResult {
  readonly conversationId: string;
  readonly status: ConversationStatus;
  /** Last assistant text (thinking excluded; only `type === "text"` chunks). */
  readonly reply: string;
  readonly truncated: boolean;
  readonly waitTimeout?: boolean;
  readonly waitCancelled?: boolean;
}

// ─── send_agent_message ─────────────────────────────────────────────────────

export interface SendAgentInput {
  readonly callerConversationId: string;
  readonly conversationId: string;
  readonly message: string;
  readonly files?: readonly string[];
  readonly wait?: boolean;
  readonly open?: boolean;
  readonly signal?: AbortSignal;
}

export interface SendAgentResult {
  readonly conversationId: string;
  /** `started-turn` (target was idle → new turn) or `queued` (target was active). */
  readonly delivered: "started-turn" | "queued";
  /** Queued-message id, present when `delivered: "queued"`. */
  readonly messageId?: string;
  readonly reply?: string;
  readonly truncated?: boolean;
  readonly waitTimeout?: boolean;
  readonly waitCancelled?: boolean;
}

// ─── cancel_agent_message ───────────────────────────────────────────────────

export interface CancelAgentMessageInput {
  readonly callerConversationId: string;
  readonly conversationId: string;
  readonly messageId: string;
}

export interface CancelAgentMessageResult {
  readonly conversationId: string;
  readonly cancelled: boolean;
  readonly queueLength: number;
}

// ─── open_agent ─────────────────────────────────────────────────────────────

export interface OpenAgentInput {
  readonly callerConversationId: string;
  readonly conversationId: string;
}

export interface OpenAgentResult {
  readonly conversationId: string;
  readonly workspaceId: string;
}

// ─── Service interface + handle ─────────────────────────────────────────────

export interface AgentManagementService {
  listModels(input: ListModelsInput): Promise<Result<ListModelsResult>>;
  summon(input: SummonAgentInput): Promise<Result<SummonAgentResult>>;
  list(input: ListAgentsInput): Promise<Result<ListAgentsResult>>;
  read(input: ReadAgentInput): Promise<Result<ReadAgentResult>>;
  send(input: SendAgentInput): Promise<Result<SendAgentResult>>;
  cancelMessage(input: CancelAgentMessageInput): Promise<Result<CancelAgentMessageResult>>;
  open(input: OpenAgentInput): Promise<Result<OpenAgentResult>>;
}

/**
 * Typed handle anchoring the agent-management service. The single symbol
 * consumers (tools, `vision-handoff`) import — no string-keyed lookup.
 */
export const agentManagementHandle: ServiceHandle<AgentManagementService> =
  defineService<AgentManagementService>("agent-management/service");

/** Re-exported so consumers can emit the open signal via the typed hook. */
export type { ConversationToolPolicy, EventHookDescriptor };
