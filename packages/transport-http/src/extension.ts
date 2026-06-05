import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { credentialStoreHandle, sessionOrchestratorHandle } from "./seam.js";

export const manifest: Manifest = {
	id: "transport-http",
	name: "Transport HTTP",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	dependsOn: ["credential-store", "session-orchestrator"],
	capabilities: { network: true },
	contributes: { routes: ["/chat", "/health", "/models"] },
	activation: "eager",
};

export interface CreateServerOptions {
	readonly port?: number;
}

export function createServer(host: HostAPI, _opts?: CreateServerOptions): Hono {
	const orchestrator = host.getService(sessionOrchestratorHandle);
	const credentialStore = host.getService(credentialStoreHandle);
	return createApp({ orchestrator, credentialStore });
}

export const extension: Extension = {
	manifest,
	activate: (_host: HostAPI) => {},
};
