/**
 * System-prompt service handle + interface.
 *
 * The service is the single-responder anchor the session-orchestrator obtains
 * (lazily, via `host.getService(systemPromptHandle)`) to construct and read the
 * per-conversation resolved system prompt.
 */
import { defineService, type ServiceHandle } from "@dispatch/kernel";

/**
 * The system-prompt service.
 *
 * `construct` resolves the template once (first turn / compaction), appends
 * mandatory application guidance, and persists the result. `get` reads the
 * persisted result unchanged on subsequent turns (cache-safe — no per-turn
 * reconstruction or retroactive guidance injection).
 */
export interface SystemPromptService {
  /**
   * Resolve the template against the current environment and persist the
   * result plus mandatory application guidance under `resolved:<conversationId>`.
   * Returns that complete string. When no template is stored, the built-in
   * default template is used. An empty template yields guidance only. The stored
   * template is never rewritten. Reconstructing replaces the conversation's
   * resolved prompt; existing persisted prompts stay unchanged until then.
   *
   * When `context.computerId` is set, the resolver uses remote-backed adapters
   * (reading the remote's `/etc/os-release`, `hostname`, `uname`, `git` via
   * the ExecBackend/SSH) so the system prompt reflects the REMOTE machine.
   */
  construct(
    conversationId: string,
    cwd: string,
    context?: {
      readonly model?: string;
      readonly workspaceId?: string;
      readonly computerId?: string;
    },
  ): Promise<string>;

  /**
   * Resolve an ARBITRARY template string against the current environment,
   * using the SAME variable resolver + adapter set as `construct` (so a
   * caller that owns its own prompt — e.g. the heartbeat extension — gets
   * `[type:name]` placeholders substituted identically to the global
   * template). Pure resolution: nothing is persisted (the result is the
   * caller's to use). An empty template yields an empty string. Unlike
   * `construct`, this does NOT append mandatory application guidance.
   *
   * Like `construct`, when `context.computerId` is set the resolver uses
   * remote-backed adapters (reading the remote's OS/hostname/git via SSH).
   */
  resolveText(
    template: string,
    cwd: string,
    context?: {
      readonly model?: string;
      readonly conversationId?: string;
      readonly workspaceId?: string;
      readonly computerId?: string;
    },
  ): Promise<string>;

  /** Read the persisted resolved system prompt, or `null` if never constructed. */
  get(conversationId: string): Promise<string | null>;

  /**
   * Read the persisted resolved system prompt AND the cwd + computerId it was
   * built against. Returns `{ prompt: null, cwd: null, computerId: null }` if
   * never constructed. Consumers use this to detect whether the cached prompt
   * is stale relative to the current effective cwd or computerId.
   */
  getWithMeta(conversationId: string): Promise<{
    readonly prompt: string | null;
    readonly cwd: string | null;
    readonly computerId: string | null;
  }>;

  /** Read the global template (or `DEFAULT_TEMPLATE` when none is stored). */
  getTemplate(): Promise<string>;

  /** Set the global template verbatim. Empty omits user content, not app guidance. */
  setTemplate(template: string): Promise<void>;
}

/**
 * Typed handle anchoring the system-prompt service. The single symbol the
 * session-orchestrator imports to reach the builder — no string-keyed lookup.
 */
export const systemPromptHandle: ServiceHandle<SystemPromptService> =
  defineService<SystemPromptService>("system-prompt");
