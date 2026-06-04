import { conversationStoreHandle } from "@dispatch/conversation-store";
import type {
	Extension,
	HostAPI,
	Manifest,
	ProviderContract,
	ToolContract,
} from "@dispatch/kernel";
import { runTurn } from "@dispatch/kernel";
import {
	createSessionOrchestrator,
	type SessionOrchestrator,
	sessionOrchestratorHandle,
} from "./orchestrator.js";
import { selectFirstProvider } from "./pure.js";

export const manifest: Manifest = {
	id: "session-orchestrator",
	name: "Session Orchestrator",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	dependsOn: ["conversation-store"],
	activation: "eager",
	contributes: {
		services: ["session-orchestrator/orchestrator"],
	},
};

interface ProviderResolvingHostAPI extends HostAPI {
	readonly getProviders?: () => ReadonlyMap<string, ProviderContract>;
	readonly getTools?: () => ReadonlyMap<string, ToolContract>;
}

export function activate(host: HostAPI): void {
	const conversationStore = host.getService(conversationStoreHandle);
	const extendedHost = host as ProviderResolvingHostAPI;

	const orchestrator: SessionOrchestrator = createSessionOrchestrator({
		conversationStore,
		resolveProvider: () => {
			if (extendedHost.getProviders !== undefined) {
				return selectFirstProvider(extendedHost.getProviders());
			}
			throw new Error(
				"HostAPI does not expose getProviders() — change-request: add provider resolution to HostAPI",
			);
		},
		resolveTools: () => {
			if (extendedHost.getTools !== undefined) {
				return [...extendedHost.getTools().values()];
			}
			return [];
		},
		runTurn,
	});

	host.provideService(sessionOrchestratorHandle, orchestrator);
}

export const extension: Extension = {
	manifest,
	activate,
};
