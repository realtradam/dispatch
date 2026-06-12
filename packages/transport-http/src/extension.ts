import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createApp } from "./app.js";
import {
	cacheWarmHandle,
	conversationStoreHandle,
	credentialStoreHandle,
	lspServiceHandle,
	sessionOrchestratorHandle,
	throughputStoreHandle,
} from "./seam.js";

export const manifest: Manifest = {
	id: "transport-http",
	name: "Transport HTTP",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	dependsOn: [
		"conversation-store",
		"credential-store",
		"lsp",
		"session-orchestrator",
		"throughput-store",
	],
	capabilities: { network: true },
	contributes: {
		routes: [
			"/chat",
			"/chat/warm",
			"/conversations/:id",
			"/conversations/:id/close",
			"/conversations/:id/cwd",
			"/conversations/:id/lsp",
			"/health",
			"/models",
			"/metrics/throughput",
		],
	},
	activation: "eager",
};

export function createTransportHttpExtension(): Extension & {
	readonly _testServer: ReturnType<typeof Bun.serve> | undefined;
} {
	let server: ReturnType<typeof Bun.serve> | undefined;

	return {
		get _testServer() {
			return server;
		},
		manifest,
		async activate(host: HostAPI) {
			const conversationStore = host.getService(conversationStoreHandle);
			const orchestrator = host.getService(sessionOrchestratorHandle);
			const credentialStore = host.getService(credentialStoreHandle);
			const throughputStore = host.getService(throughputStoreHandle);
			const warmService = host.getService(cacheWarmHandle);
			const lspService = host.getService(lspServiceHandle);
			const logger = host.logger;

			const app = createApp({
				conversationStore,
				orchestrator,
				credentialStore,
				throughputStore,
				warmService,
				lspService,
				logger,
			});

			const port = host.config.get<number>("httpPort") ?? 24203;

			server = Bun.serve({
				port,
				fetch: app.fetch,
			});

			logger.info("transport-http: listening", { port });
		},

		deactivate() {
			if (server) {
				server.stop();
				server = undefined;
			}
		},
	};
}
