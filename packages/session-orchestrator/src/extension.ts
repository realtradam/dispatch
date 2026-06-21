import { conversationStoreHandle } from "@dispatch/conversation-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { runTurn } from "@dispatch/kernel";
import { messageQueueHandle } from "@dispatch/message-queue";
import {
	cacheWarmHandle,
	compactionHandle,
	createCompactionService,
	createSessionOrchestrator,
	createWarmService,
	sessionOrchestratorHandle,
} from "./orchestrator.js";
import { selectFirstProvider } from "./pure.js";
import { toolsFilter } from "./tools-filter.js";

export const manifest: Manifest = {
	id: "session-orchestrator",
	name: "Session Orchestrator",
	version: "0.0.0",
	apiVersion: "^0.1.0",
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
		applyToolsFilter: (assembly) => host.applyFilters(toolsFilter, assembly),
		runTurn,
		logger: host.logger,
		now: () => Date.now(),
		emit: (hook, payload) => host.emit(hook, payload),
		resolveQueue: () => {
			// Lazily resolve the message-queue service. Returns undefined when the
			// extension isn't loaded (feature degrades off) — checked via the
			// activated-manifests list so `host.getService` is only called when the
			// service is registered. Lazy so activation order with message-queue
			// doesn't matter; called per-turn / per-enqueue, not at activate time.
			const loaded = host.getExtensions().some((m) => m.id === "message-queue");
			return loaded ? host.getService(messageQueueHandle) : undefined;
		},
		resolveCompaction: () => {
			// Lazily resolve the compaction service (registered below after
			// the orchestrator). By the time this is called at runtime
			// (after a turn settles), the service is registered.
			try {
				return host.getService(compactionHandle);
			} catch {
				return undefined;
			}
		},
	});

	host.provideService(sessionOrchestratorHandle, orchestrator);

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
