import { conversationStoreHandle } from "@dispatch/conversation-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { runTurn } from "@dispatch/kernel";
import { messageQueueHandle } from "@dispatch/message-queue";
import { concurrencyServiceHandle } from "@dispatch/provider-concurrency";
import { systemPromptHandle } from "@dispatch/system-prompt";
import {
  cacheWarmHandle,
  compactionHandle,
  createCompactionService,
  createSessionOrchestrator,
  createWarmService,
  sessionOrchestratorHandle,
  visionHandoffLocalHandle,
} from "./orchestrator.js";
import { selectFirstProvider } from "./pure.js";
import { filterRemoteIncompatibleTools, toolsFilter } from "./tools-filter.js";

export const manifest: Manifest = {
  id: "session-orchestrator",
  name: "Session Orchestrator",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "core",
  trust: "bundled",
  dependsOn: ["conversation-store", "credential-store"],
  activation: "eager",
  contributes: {
    services: [
      "session-orchestrator/orchestrator",
      "session-orchestrator/warm",
      "session-orchestrator/compaction",
    ],
    hooks: [
      "session-orchestrator/turn-started",
      "session-orchestrator/turn-settled",
      "session-orchestrator/warm-completed",
      "session-orchestrator/conversation-closed",
      "session-orchestrator/conversation-status-changed",
      "session-orchestrator/conversation-compacted",
    ],
  },
};

export function activate(host: HostAPI): void {
  const conversationStore = host.getService(conversationStoreHandle);

  const { orchestrator, activeConversations } = createSessionOrchestrator({
    conversationStore,
    resolveProvider: () => selectFirstProvider(host.getProviders()),
    resolveTools: () => [...host.getTools().values()],
    resolveModel: (modelName: string) => {
      const store = host.getService(credentialStoreHandle);
      const r = store.resolve(modelName);
      if (r === undefined) return undefined;
      const provider = host.getProviders().get(r.providerId);
      return provider ? { provider, model: r.model } : undefined;
    },
    resolveModelInfo: async (modelName: string) => {
      const store = host.getService(credentialStoreHandle);
      return store.getModelInfo(modelName);
    },
    applyToolsFilter: (assembly) => host.applyFilters(toolsFilter, assembly),
    runTurn,
    logger: host.logger,
    now: () => Date.now(),
    emit: (hook, payload) => host.emit(hook, payload),
    // Injected process.memoryUsage() sampler — the production edge. Tests
    // inject a fake to assert per-turn before/after telemetry. Wired in the
    // shell (like `now: () => Date.now()`); pure decision logic is untouched.
    sampleMemory: () => {
      const m = process.memoryUsage();
      return {
        rss: m.rss,
        heapUsed: m.heapUsed,
        heapTotal: m.heapTotal,
        external: m.external,
        arrayBuffers: m.arrayBuffers,
      };
    },
    resolveQueue: () => {
      // Reactive registry lookup (plan 03): non-throwing, resolved per call —
      // per-turn/per-enqueue reads always see the CURRENT registry state, so
      // the message-queue plugin loaded or unloaded mid-session is picked up
      // on the next turn with no restart. Undefined → queueing degrades off
      // (the steering message is dropped / nothing to cancel).
      return host.tryGetService(messageQueueHandle);
    },
    resolveCompaction: () => {
      // Reactive registry lookup (plan 03): non-throwing, per call. The
      // compaction service is core-provided (by this very extension, after
      // the orchestrator) — registered by the time a turn settles.
      return host.tryGetService(compactionHandle);
    },
    resolveSystemPrompt: () => {
      // Reactive registry lookup (plan 03): non-throwing, per call. Returns
      // undefined when the system-prompt extension isn't loaded (no system
      // prompt sent — current behavior); activation order no longer matters.
      return host.tryGetService(systemPromptHandle);
    },
    resolveConcurrencyLimiter: () => {
      // Reactive registry lookup (plan 03): non-throwing, per call. Returns
      // undefined when the provider-concurrency extension isn't loaded (no
      // concurrency limiting — feature degrades off).
      return host.tryGetService(concurrencyServiceHandle);
    },
    resolveVisionHandoff: () => {
      // Reactive registry lookup (plan 03): non-throwing, per call. Returns
      // undefined when the vision-handoff extension isn't loaded (images pass
      // through unchanged — correct for vision-capable models; the feature
      // degrades off cleanly for text-only turns).
      return host.tryGetService(visionHandoffLocalHandle);
    },
  });

  host.provideService(sessionOrchestratorHandle, orchestrator);

  // Remote-degradation rule (plan §6): when a turn is REMOTE
  // (`assembly.computerId !== undefined`), drop tools that spawn local
  // processes and cannot run over SFTP — the `lsp` tool (local LSP servers)
  // and MCP-namespaced tools (`<serverId>__<toolName>`, local MCP servers).
  // When LOCAL (`computerId === undefined`), the filter is a passthrough —
  // byte-identical to today. Registered at default priority (0) with
  // activation-order tie-breaking: session-orchestrator activates before
  // MCP (which dependsOn it), so this runs FIRST in the chain — the drops
  // happen before MCP's filter connects/registers servers. Mirrors how MCP
  // adds its own filter via host.addFilter.
  host.addFilter(toolsFilter, filterRemoteIncompatibleTools);

  const warmService = createWarmService(
    {
      conversationStore,
      resolveProvider: () => selectFirstProvider(host.getProviders()),
      resolveTools: () => [...host.getTools().values()],
      resolveModel: (modelName: string) => {
        const store = host.getService(credentialStoreHandle);
        const r = store.resolve(modelName);
        if (r === undefined) return undefined;
        const provider = host.getProviders().get(r.providerId);
        return provider ? { provider, model: r.model } : undefined;
      },
      applyToolsFilter: (assembly) => host.applyFilters(toolsFilter, assembly),
      runTurn,
      logger: host.logger,
      now: () => Date.now(),
      emit: (hook, payload) => host.emit(hook, payload),
    },
    activeConversations,
  );

  host.provideService(cacheWarmHandle, warmService);

  const compactionService = createCompactionService(
    {
      conversationStore,
      resolveProvider: () => selectFirstProvider(host.getProviders()),
      resolveTools: () => [...host.getTools().values()],
      resolveModel: (modelName: string) => {
        const store = host.getService(credentialStoreHandle);
        const r = store.resolve(modelName);
        if (r === undefined) return undefined;
        const provider = host.getProviders().get(r.providerId);
        return provider ? { provider, model: r.model } : undefined;
      },
      resolveModelInfo: async (modelName: string) => {
        const store = host.getService(credentialStoreHandle);
        return store.getModelInfo(modelName);
      },
      resolveSystemPrompt: () => {
        // Reactive registry lookup (plan 03) — non-throwing, per call.
        return host.tryGetService(systemPromptHandle);
      },
      applyToolsFilter: (assembly) => host.applyFilters(toolsFilter, assembly),
      runTurn,
      logger: host.logger,
      now: () => Date.now(),
      emit: (hook, payload) => host.emit(hook, payload),
    },
    activeConversations,
  );

  host.provideService(compactionHandle, compactionService);
}

export const extension: Extension = {
  manifest,
  activate,
};
