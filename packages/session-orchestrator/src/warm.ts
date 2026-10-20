import {
  type ChatMessage,
  defineService,
  type EventHookDescriptor,
  type ProviderContract,
  type ProviderEvent,
  type ProviderStreamOptions,
  type ServiceHandle,
  type UsageEvent,
} from "@dispatch/kernel";
import { wrapProviderWithConcurrency } from "@dispatch/provider-concurrency";
import { warmCompleted } from "./hooks.js";
import type { SessionOrchestratorDeps } from "./orchestrator.js";
import { resolveModelName, resolveReasoningEffort } from "./pure.js";

// --- Warm service ---

export interface WarmResult {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface WarmService {
  readonly warm: (
    conversationId: string,
    opts?: { readonly cwd?: string; readonly modelName?: string },
  ) => Promise<WarmResult | { readonly error: string }>;
}

export const cacheWarmHandle: ServiceHandle<WarmService> = defineService<WarmService>(
  "session-orchestrator/warm",
);

/** Deps for the warm service — emit is REQUIRED so warmCompleted is never silently dropped. */
export type WarmServiceDeps = SessionOrchestratorDeps & {
  readonly emit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;
};

export function createWarmService(
  deps: WarmServiceDeps,
  activeConversations: ReadonlySet<string>,
): WarmService {
  return {
    async warm(conversationId, opts) {
      if (activeConversations.has(conversationId)) {
        return { error: "conversation is generating" };
      }

      const history = await deps.conversationStore.load(conversationId);
      if (history.length === 0) {
        return { error: "no history" };
      }

      let provider: ProviderContract;
      let modelOverride: string | undefined;

      // Resolve the model the SAME way the real turn does: per-turn override
      // → persisted per-conversation model → default provider. A mismatch here
      // silently busts the prompt cache (the model block of the prompt prefix
      // diverges from the real turn's). Warm is a probe — it does NOT persist
      // (no setModel), it only reads so it sends the same model the next real
      // turn will. See notes/observability-design.md §3.1.
      const storedModel = await deps.conversationStore.getModel(conversationId);
      const effectiveModelName = resolveModelName(opts?.modelName, storedModel);

      if (effectiveModelName !== undefined && deps.resolveModel !== undefined) {
        const resolved = deps.resolveModel(effectiveModelName);
        if (resolved === undefined) {
          return { error: `unknown model: ${effectiveModelName}` };
        }
        provider = resolved.provider;
        modelOverride = resolved.model;
      } else {
        provider = deps.resolveProvider();
      }

      // Per-workspace model-unavailable rule (§8) — the warm probe warms the
      // SAME model the next real turn would use; when that model is not
      // usable in this conversation's workspace the real turn will error
      // immediately, so warming it would be a wasted provider round-trip.
      const warmWorkspaceId = await deps.conversationStore.getWorkspaceId(conversationId);
      if (
        effectiveModelName !== undefined &&
        deps.resolveModelUsability !== undefined &&
        !(await deps.resolveModelUsability(effectiveModelName, warmWorkspaceId))
      ) {
        return { error: `model ${effectiveModelName} unavailable — pick another` };
      }

      // Wrap with concurrency limiting (same as the main turn path).
      const warmLimiter = deps.resolveConcurrencyLimiter?.();
      if (warmLimiter !== undefined) {
        provider = wrapProviderWithConcurrency(
          provider,
          warmLimiter,
          conversationId,
          warmWorkspaceId,
          deps.now?.() ?? Date.now(),
        );
      }

      const baseTools = deps.resolveTools();
      // Resolve cwd the SAME way handleMessage does — pass opts.cwd as the overrideCwd
      // The tools filter is cwd-sensitive (e.g. skill discovery rewrites the
      // `load_skill` description per-cwd). If the warm assembles tools under a
      // different cwd than the real turn, the tools block — the FIRST bytes of
      // the prompt-cache prefix — diverges and the cache misses entirely (0%).
      // A manual reheat sends no cwd, so without this fallback it would warm the
      // wrong prefix. See notes/observability-design.md §3.1.
      const cwd =
        (await deps.conversationStore.getEffectiveCwd(conversationId, opts?.cwd)) ?? undefined;
      const filtered = await deps.applyToolsFilter({
        tools: baseTools,
        conversationId,
        ...(cwd !== undefined ? { cwd } : {}),
        // Same workspace context as the real turn's assembly, so
        // workspace-aware filters (the MCP injection short-circuit) behave
        // identically during a warm (§6.3).
        ...(warmWorkspaceId !== undefined ? { workspaceId: warmWorkspaceId } : {}),
      });
      // Same per-workspace tool gate as the real turn — a warm prefix that
      // includes workspace-gated tools the real turn drops would cache-miss
      // on the next real turn (coherence, §6.3).
      const assembled =
        deps.applyWorkspaceGate !== undefined ? await deps.applyWorkspaceGate(filtered) : filtered;

      // Resolve reasoning effort the SAME way the real turn does (stored → "high";
      // no per-turn override on warm). A mismatch here silently busts the prompt cache.
      const storedEffort = await deps.conversationStore.getReasoningEffort(conversationId);
      const resolvedEffort = resolveReasoningEffort(undefined, storedEffort);

      const probeMsg: ChatMessage = {
        role: "user",
        chunks: [{ type: "text", text: "reply with just a ." }],
      };
      const messages = [...history, probeMsg];

      // Capture the warm send as a `provider.request` span, flagged `warm: true`
      // so it can be diffed against the corresponding real turn's request (the
      // prompt-cache 0%-hit debugging workflow — see notes/observability-design.md
      // §3.1). Without this the warm body is invisible and the cache bust is
      // undebuggable. The child-bound `warm` attribute flows into the span the
      // provider opens (kernel logger merges child attrs into span attributes).
      const warmLogger = deps.logger?.child({ conversationId, attrs: { warm: true } });
      const providerOpts: ProviderStreamOptions = {
        maxTokens: 1,
        reasoningEffort: resolvedEffort,
        ...(modelOverride !== undefined ? { model: modelOverride } : {}),
        ...(warmLogger !== undefined ? { logger: warmLogger } : {}),
      };

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;

      for await (const event of provider.stream(messages, assembled.tools, providerOpts)) {
        if ((event as ProviderEvent).type === "usage") {
          const usageEvent = event as UsageEvent;
          inputTokens = usageEvent.usage.inputTokens;
          outputTokens = usageEvent.usage.outputTokens;
          cacheReadTokens = usageEvent.usage.cacheReadTokens ?? 0;
          cacheWriteTokens = usageEvent.usage.cacheWriteTokens ?? 0;
        }
      }

      const result: WarmResult = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
      deps.emit(warmCompleted, { conversationId, usage: result });
      return result;
    },
  };
}
