import { conversationStoreHandle } from "@dispatch/conversation-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { runTurn } from "@dispatch/kernel";
import {
	cacheWarmHandle,
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
		services: ["session-orchestrator/orchestrator", "session-orchestrator/warm"],
		hooks: [
			"session-orchestrator/turn-started",
			"session-orchestrator/turn-settled",
			"session-orchestrator/warm-completed",
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
}

export const extension: Extension = {
	manifest,
	activate,
};
