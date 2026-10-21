import {
  abortableIteration,
  defineService,
  type EventHookDescriptor,
  type ProviderContract,
  type ServiceHandle,
} from "@dispatch/kernel";
import { wrapProviderWithConcurrency } from "@dispatch/provider-concurrency";
import { assembleTurnRequest } from "./assemble.js";
import { warmCompleted } from "./hooks.js";
import type { SessionOrchestratorDeps } from "./orchestrator.js";

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
    opts?: {
      readonly cwd?: string;
      readonly modelName?: string;
      readonly computerId?: string;
      readonly signal?: AbortSignal;
    },
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

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("warm timed out after 60000ms")),
        60_000,
      );
      const signal =
        opts?.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, opts.signal]);
      const warmLogger = deps.logger?.child({ conversationId, attrs: { warm: true } });
      // Race assembly as well as streaming: filters/vision may also hang on I/O.
      async function* performWarm(): AsyncGenerator<WarmResult | { readonly error: string }> {
        const history = await deps.conversationStore.load(conversationId);
        if (history.length === 0) {
          yield { error: "no history" };
          return;
        }
        const request = await assembleTurnRequest(deps, {
          conversationId,
          ...opts,
          signal,
          readOnly: true,
          messages: [
            ...history,
            { role: "user", chunks: [{ type: "text", text: "reply with just a ." }] },
          ],
          ...(warmLogger !== undefined ? { logger: warmLogger } : {}),
        });
        signal.throwIfAborted();
        const rawProvider = request.provider;
        // Race the underlying next() INSIDE the concurrency wrapper too. Returning
        // the outer async generator alone cannot unwind a hung inner await, so
        // its finally/release would otherwise wait for the slot watchdog.
        let provider: ProviderContract = {
          ...rawProvider,
          stream: (...args: Parameters<typeof rawProvider.stream>) =>
            abortableIteration(rawProvider.stream(...args)[Symbol.asyncIterator](), signal),
        };
        const limiter = deps.resolveConcurrencyLimiter?.();
        if (limiter !== undefined) {
          provider = wrapProviderWithConcurrency(
            provider,
            limiter,
            conversationId,
            request.turnWorkspaceId,
            deps.now?.() ?? Date.now(),
          );
        }
        let usage: WarmResult = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        const stream = provider.stream(request.providerMessages, request.tools, {
          ...request.providerOpts,
          maxTokens: 1,
          signal,
          ...(warmLogger !== undefined ? { logger: warmLogger } : {}),
        });
        for await (const event of abortableIteration(stream[Symbol.asyncIterator](), signal)) {
          if (event.type === "error") {
            yield { error: event.message };
            return;
          }
          if (event.type === "usage") {
            usage = {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cacheReadTokens: event.usage.cacheReadTokens ?? 0,
              cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
            };
          }
        }
        signal.throwIfAborted();
        yield usage;
      }
      try {
        for await (const result of abortableIteration(performWarm(), signal)) {
          signal.throwIfAborted();
          if (!("error" in result)) deps.emit(warmCompleted, { conversationId, usage: result });
          return result;
        }
        signal.throwIfAborted();
        return { error: "warm ended without a result" };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
