import type { ChatMessage, Logger, ProviderStreamOptions, ReasoningEffort } from "@dispatch/kernel";
import { appendTextFileGuidance } from "@dispatch/system-prompt";
import type { SessionOrchestratorDeps } from "./orchestrator.js";
import { resolveModelName, resolveReasoningEffort } from "./pure.js";
import { applyToolPolicy } from "./tools-filter.js";

/** Validation rejection is distinct from assembly/provider failures. */
export class TurnRequestRejected extends Error {}

interface TurnContext {
  readonly effectiveCwd: string | undefined;
  readonly effectiveComputerId: string | undefined;
  readonly effectiveModelName: string | undefined;
  readonly resolvedEffort: ReasoningEffort;
  readonly turnWorkspaceId: string;
}

interface AssembleTurnInput {
  readonly conversationId: string;
  readonly modelName?: string;
  readonly cwd?: string;
  readonly computerId?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly systemPrompt?: string;
  readonly signal: AbortSignal;
  readonly messages?: readonly ChatMessage[];
  readonly logger?: Logger;
  readonly isNewConversation?: boolean;
  /** Warm resolves stale prompts without writing conversation or prompt state. */
  readonly readOnly?: boolean;
  /** The real turn reuses its lifecycle snapshot, taken before input persistence. */
  readonly context?: TurnContext;
}

/** Single cache-prefix assembly path. Warm is read-only; caller owns concurrency. */
export async function assembleTurnRequest(deps: SessionOrchestratorDeps, input: AssembleTurnInput) {
  const { conversationId } = input;
  // Real turns still reach runTurn after an early Stop so partial input seals.
  // Warm has no durability work and must not start late I/O after its deadline.
  const checkWarmAbort = () => {
    if (input.readOnly) input.signal.throwIfAborted();
  };
  checkWarmAbort();
  const context = input.context ?? {
    effectiveCwd:
      (await deps.conversationStore.getEffectiveCwd(conversationId, input.cwd)) ?? undefined,
    effectiveComputerId:
      (await deps.conversationStore.getEffectiveComputer(conversationId, input.computerId)) ??
      undefined,
    effectiveModelName: resolveModelName(
      input.modelName,
      await deps.conversationStore.getModel(conversationId),
    ),
    resolvedEffort: resolveReasoningEffort(
      input.reasoningEffort,
      await deps.conversationStore.getReasoningEffort(conversationId),
    ),
    turnWorkspaceId: await deps.conversationStore.getWorkspaceId(conversationId),
  };
  const { effectiveCwd, effectiveComputerId, effectiveModelName, resolvedEffort, turnWorkspaceId } =
    context;
  if (
    effectiveModelName !== undefined &&
    deps.resolveModelUsability !== undefined &&
    !(await deps.resolveModelUsability(effectiveModelName, turnWorkspaceId))
  ) {
    throw new TurnRequestRejected(`model ${effectiveModelName} unavailable — pick another`);
  }
  const resolved =
    effectiveModelName !== undefined && deps.resolveModel !== undefined
      ? deps.resolveModel(effectiveModelName)
      : undefined;
  if (
    effectiveModelName !== undefined &&
    deps.resolveModel !== undefined &&
    resolved === undefined
  ) {
    throw new TurnRequestRejected(`unknown model: ${effectiveModelName}`);
  }
  const provider = resolved?.provider ?? deps.resolveProvider();
  const modelOverride = resolved?.model;
  // Preserve real-turn ordering: model-aware filters/prompt construction may
  // read the stored model. Unknown/unavailable models are never persisted.
  if (!input.readOnly && resolved !== undefined && effectiveModelName !== undefined) {
    await deps.conversationStore.setModel(conversationId, effectiveModelName);
  }

  checkWarmAbort();
  const baseTools = deps.resolveTools();
  const filtered = await deps.applyToolsFilter({
    tools: baseTools,
    conversationId,
    ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
    ...(effectiveComputerId !== undefined ? { computerId: effectiveComputerId } : {}),
    ...(effectiveModelName !== undefined ? { modelName: effectiveModelName } : {}),
    ...(turnWorkspaceId !== undefined ? { workspaceId: turnWorkspaceId } : {}),
    signal: input.signal,
  });
  checkWarmAbort();
  const gated =
    deps.applyWorkspaceGate !== undefined ? await deps.applyWorkspaceGate(filtered) : filtered;
  const persistedPolicy = await deps.conversationStore.getToolPolicy(conversationId);
  const policy = persistedPolicy ?? ({ mode: "all" } as const);
  const assembled = applyToolPolicy(gated, policy);

  checkWarmAbort();
  let systemPrompt: string | undefined;
  if (input.systemPrompt !== undefined) {
    systemPrompt = input.systemPrompt;
  } else {
    const systemPromptService = deps.resolveSystemPrompt?.();
    if (systemPromptService !== undefined) {
      const currentCwd = effectiveCwd ?? process.cwd();
      const currentComputerId = effectiveComputerId ?? null;
      const meta = input.isNewConversation
        ? undefined
        : await systemPromptService.getWithMeta(conversationId);
      // Cached bytes win, even if the template changed. Only cwd/computer (or
      // missing metadata) invalidate the prompt, exactly as for a real turn.
      if (
        meta?.prompt != null &&
        meta.cwd === currentCwd &&
        meta.computerId === currentComputerId
      ) {
        systemPrompt = meta.prompt;
      } else {
        const promptContext = {
          ...(effectiveModelName !== undefined ? { model: effectiveModelName } : {}),
          workspaceId: turnWorkspaceId,
          ...(effectiveComputerId !== undefined ? { computerId: effectiveComputerId } : {}),
        };
        // Warm must reproduce construct's complete initial context without
        // persisting it; generic resolveText intentionally omits app guidance.
        systemPrompt = input.readOnly
          ? appendTextFileGuidance(
              await systemPromptService.resolveText(
                await systemPromptService.getTemplate(),
                currentCwd,
                {
                  ...promptContext,
                  conversationId,
                },
              ),
            )
          : await systemPromptService.construct(conversationId, currentCwd, promptContext);
      }
    }
  }

  const providerOpts: ProviderStreamOptions = {
    reasoningEffort: resolvedEffort,
    ...(modelOverride !== undefined ? { model: modelOverride } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  };

  checkWarmAbort();
  const visionHandoff = deps.resolveVisionHandoff?.();
  let providerMessages = input.messages ?? (await deps.conversationStore.load(conversationId));
  if (visionHandoff !== undefined) {
    const visionSettings = await deps.conversationStore.getVisionSettings();
    const hasImages = providerMessages.some((message) =>
      message.chunks.some((chunk) => chunk.type === "image"),
    );
    const modelMaxImages =
      hasImages && effectiveModelName !== undefined && deps.resolveModelInfo !== undefined
        ? (await deps.resolveModelInfo(effectiveModelName))?.maxImages
        : undefined;
    const imageLimit =
      modelMaxImages === undefined
        ? visionSettings.imageLimit
        : visionSettings.imageLimit > 0
          ? Math.min(visionSettings.imageLimit, modelMaxImages)
          : modelMaxImages;
    providerMessages = await visionHandoff.prepareForProvider(
      providerMessages,
      effectiveModelName,
      {
        conversationId,
        imageLimit,
        compactionModel: visionSettings.compactionModel,
        signal: input.signal,
        ...(input.logger !== undefined ? { logger: input.logger } : {}),
      },
    );
  }

  return { provider, providerOpts, tools: assembled.tools, providerMessages, ...context };
}
