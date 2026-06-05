import { conversationStoreHandle } from "@dispatch/conversation-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
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

export function activate(host: HostAPI): void {
	const conversationStore = host.getService(conversationStoreHandle);

	const orchestrator: SessionOrchestrator = createSessionOrchestrator({
		conversationStore,
		resolveProvider: () => selectFirstProvider(host.getProviders()),
		resolveTools: () => [...host.getTools().values()],
		runTurn,
		logger: host.logger,
	});

	host.provideService(sessionOrchestratorHandle, orchestrator);
}

export const extension: Extension = {
	manifest,
	activate,
};
