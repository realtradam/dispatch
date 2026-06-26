/**
 * System-prompt service factory — owns the construct/get decision logic.
 *
 * Pure-ish: takes a storage namespace + resolver adapters as deps (both
 * injectable), so the service is testable with an in-memory storage and fake
 * adapters. The real Bun-backed adapters are wired in `extension.ts`.
 */
import type { StorageNamespace } from "@dispatch/kernel";
import { extractVariables, parseTemplate } from "./parser.js";
import type { ResolverAdapters, ResolverContext } from "./resolver.js";
import { resolveVariables } from "./resolver.js";
import type { SystemPromptService } from "./types.js";

/**
 * The default template used when no template has been stored. Embeds the
 * working directory and an optional `AGENTS.md` (only when the file exists).
 */
export const DEFAULT_TEMPLATE = `You are a helpful coding assistant.

[if file:AGENTS.md]
[file:AGENTS.md]
[endif]

The current working directory is [prompt:cwd].
`;

/** Storage keys. */
const TEMPLATE_KEY = "template";
const resolvedKey = (conversationId: string): string => `resolved:${conversationId}`;
const resolvedCwdKey = (conversationId: string): string => `resolved-cwd:${conversationId}`;
const resolvedComputerIdKey = (conversationId: string): string =>
  `resolved-computer:${conversationId}`;

export interface SystemPromptServiceDeps {
  /** Namespaced KV (`host.storage("system-prompt")`). */
  readonly storage: StorageNamespace;
  /** Injected effects for variable resolution (local). */
  readonly adapters: ResolverAdapters;
  /**
   * Optional: build remote-backed adapters for a given computerId. When
   * `construct` is called with a `computerId`, this is invoked to obtain
   * adapters that read/run commands on the REMOTE machine (via the
   * ExecBackend/SSH). Absent → falls back to the local `adapters`.
   */
  readonly resolveRemoteAdapters?: (computerId: string, cwd: string) => Promise<ResolverAdapters>;
}

/**
 * Resolve a template against the current environment (the shared resolution
 * path used by both `construct` — which persists the result — and
 * `resolveText`, which does not). Always resolves the fixed catalog
 * (`system:*`, `prompt:*`, `git:*`) plus any `file:<path>` keys referenced by
 * the template. Selects remote-backed adapters when `context.computerId` is
 * set, mirroring `construct`.
 */
async function resolveTemplate(
  deps: SystemPromptServiceDeps,
  template: string,
  cwd: string,
  context?: {
    readonly model?: string;
    readonly conversationId?: string;
    readonly workspaceId?: string;
    readonly computerId?: string;
  },
): Promise<string> {
  const referencedKeys = extractVariables(template);
  const resolverContext: ResolverContext = {
    ...(context?.conversationId !== undefined ? { conversationId: context.conversationId } : {}),
    ...(context?.model !== undefined ? { model: context.model } : {}),
    ...(context?.workspaceId !== undefined ? { workspaceId: context.workspaceId } : {}),
  };

  // Select adapters: when computerId is set, use remote-backed adapters
  // (read files / run commands on the REMOTE machine via SSH). Otherwise
  // use the local adapters.
  const computerId = context?.computerId;
  const adapters =
    computerId !== undefined && deps.resolveRemoteAdapters !== undefined
      ? await deps.resolveRemoteAdapters(computerId, cwd)
      : deps.adapters;

  const vars = await resolveVariables(cwd, adapters, {
    context: resolverContext,
    referencedKeys,
  });
  return parseTemplate(template, vars);
}

/**
 * Create a `SystemPromptService` backed by a storage namespace + adapters.
 * State is owned (not ambient): the storage reference lives in this closure.
 */
export function createSystemPromptService(deps: SystemPromptServiceDeps): SystemPromptService {
  return {
    async construct(conversationId, cwd, context) {
      let template = await deps.storage.get(TEMPLATE_KEY);
      if (template === null) template = DEFAULT_TEMPLATE;

      const result = await resolveTemplate(deps, template, cwd, {
        conversationId,
        ...(context?.model !== undefined ? { model: context.model } : {}),
        ...(context?.workspaceId !== undefined ? { workspaceId: context.workspaceId } : {}),
        ...(context?.computerId !== undefined ? { computerId: context.computerId } : {}),
      });

      await deps.storage.set(resolvedKey(conversationId), result);
      await deps.storage.set(resolvedCwdKey(conversationId), cwd);
      // Store the computerId (or empty string for local) so the cache can be
      // invalidated when the computer changes.
      await deps.storage.set(resolvedComputerIdKey(conversationId), context?.computerId ?? "");
      return result;
    },

    async resolveText(template, cwd, context) {
      // An empty template has no variables to resolve; short-circuit to
      // avoid spawning git / reading files for nothing (the heartbeat's
      // default-empty prompts hit this every run).
      if (template === "") return "";
      return resolveTemplate(deps, template, cwd, context);
    },

    async get(conversationId) {
      return deps.storage.get(resolvedKey(conversationId));
    },

    async getWithMeta(conversationId) {
      const [prompt, cwd, computerIdStored] = await Promise.all([
        deps.storage.get(resolvedKey(conversationId)),
        deps.storage.get(resolvedCwdKey(conversationId)),
        deps.storage.get(resolvedComputerIdKey(conversationId)),
      ]);
      // Empty string → null (local, no computerId). Non-empty → the alias.
      const computerId = computerIdStored === null ? null : computerIdStored || null;
      return { prompt, cwd, computerId };
    },

    async getTemplate() {
      const stored = await deps.storage.get(TEMPLATE_KEY);
      return stored ?? DEFAULT_TEMPLATE;
    },

    async setTemplate(template) {
      await deps.storage.set(TEMPLATE_KEY, template);
    },
  };
}
