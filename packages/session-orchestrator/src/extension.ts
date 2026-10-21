import { conversationStoreHandle } from "@dispatch/conversation-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import type { Extension, HostAPI, Manifest, ToolDispatchPolicy } from "@dispatch/kernel";
import { runTurn } from "@dispatch/kernel";
import { messageQueueHandle } from "@dispatch/message-queue";
import { concurrencyServiceHandle } from "@dispatch/provider-concurrency";
import { systemPromptHandle } from "@dispatch/system-prompt";
import {
  isPluginUsable,
  usablePluginsInWorkspace,
  workspacePluginConfigHandle,
} from "@dispatch/workspace-plugin-config";
import {
  cacheWarmHandle,
  compactionHandle,
  createCompactionService,
  createSessionOrchestrator,
  createWarmService,
  sessionOrchestratorHandle,
  visionHandoffLocalHandle,
} from "./orchestrator.js";
import { pluginOwnershipHandle } from "./ownership.js";
import {
  DISPATCH_TOOL_MAX_CONCURRENT_ENV,
  resolveDispatchPolicy,
  selectFirstProvider,
} from "./pure.js";
import {
  filterRemoteIncompatibleTools,
  gateToolsForWorkspace,
  toolsFilter,
} from "./tools-filter.js";

/**
 * Resolve the operator's tool-dispatch override at the extension EDGE.
 *
 * `DISPATCH_TOOL_MAX_CONCURRENT` (integer >= 0; 0=unlimited, 1=sequential)
 * lets an operator tune the cap without a code change. The parsing/validation
 * logic is the pure {@link resolveDispatchPolicy}; this wrapper only reads the
 * injected environment and logs the warning for an invalid value. `eager`
 * always stays `true`. Ambience is confined to this edge — the orchestrator
 * receives the resolved policy as an explicit dep.
 */
export function createDispatchPolicy(
  env: Readonly<Record<string, string | undefined>>,
  logger: { readonly warn: (message: string) => void },
): ToolDispatchPolicy {
  const { policy, warning } = resolveDispatchPolicy(env[DISPATCH_TOOL_MAX_CONCURRENT_ENV]);
  if (warning !== undefined) logger.warn(`session-orchestrator: ${warning}`);
  return policy;
}

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
  // Operator override for the tool-dispatch cap, resolved once at activation
  // (env changes require a restart, like the other env-based config).
  const dispatchPolicy = createDispatchPolicy(process.env, host.logger);

  const { orchestrator, activeConversations, compacting } = createSessionOrchestrator({
    conversationStore,
    resolveProvider: () => selectFirstProvider(host.getProviders()),
    resolveTools: () => [...host.getTools().values()],
    resolveDispatch: () => dispatchPolicy,
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
    // Per-workspace enforcement (plan 06 §6.3): resolve the ledger
    // ownership + workspace-plugin-config services REACTIVELY per turn
    // (plan 03) and drop tools whose owning plugin is not usable in the
    // assembly's workspace. Degrade open when either service is absent
    // (never block a turn on a missing optional seam) or when the assembly
    // carries no workspace context. Runs AFTER the whole toolsFilter chain
    // and BEFORE applyToolPolicy — the ordering invariant (§7).
    applyWorkspaceGate: async (assembly) => {
      if (assembly.workspaceId === undefined) return assembly;
      const config = host.tryGetService(workspacePluginConfigHandle);
      const ownership = host.tryGetService(pluginOwnershipHandle);
      if (config === undefined || ownership === undefined) return assembly;
      const manifests = host.getExtensions();
      const tierOf = (pluginId: string) => manifests.find((m) => m.id === pluginId)?.tier;
      const owners = [
        ...new Set(
          assembly.tools
            .map((t) => ownership.ownerOfTool(t.name))
            .filter((id): id is string => id !== undefined),
        ),
      ];
      const usable = await usablePluginsInWorkspace(assembly.workspaceId, owners, config, tierOf);
      return gateToolsForWorkspace(assembly, usable, ownership.ownerOfTool);
    },
    // Per-workspace model-unavailable rule (§6.5): a model is usable in a
    // workspace iff its provider plugin is loaded AND usable there. Unknown
    // credentials return true here — the model-resolution path already
    // errors "unknown model" for them; this check is the KNOWN-but-not-
    // usable case. Fail-open when the ownership seam or the config store
    // is absent (the global loaded/unloaded state still applies).
    resolveModelUsability: async (modelName, workspaceId) => {
      const r = host.getService(credentialStoreHandle).resolve(modelName);
      if (r === undefined) return true; // unknown model → resolveModel's error path
      const provider = host.getProviders().get(r.providerId);
      if (provider === undefined) return false; // known credential, provider unloaded
      const config = host.tryGetService(workspacePluginConfigHandle);
      const ownership = host.tryGetService(pluginOwnershipHandle);
      if (config === undefined || ownership === undefined) return true; // degrade open
      const owner = ownership.ownerOfProvider(r.providerId);
      if (owner === undefined) return true; // unattributable → fail-open
      const manifests = host.getExtensions();
      const tier = manifests.find((m) => m.id === owner)?.tier;
      if (tier === undefined) return true; // not classifiable → fail-open
      return isPluginUsable(tier, await config.stateOf(workspaceId, owner));
    },
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
    compacting,
  );

  host.provideService(compactionHandle, compactionService);
}

export const extension: Extension = {
  manifest,
  activate,
};
