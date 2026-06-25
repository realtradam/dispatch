/**
 * Heartbeat extension — manifest + activate(host).
 *
 * Wires the heartbeat service against the session-orchestrator + a storage
 * namespace, registers the typed service handle, and arms every enabled
 * workspace's scheduler on boot.
 */

import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import {
	type SessionOrchestrator,
	sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import { createHeartbeatService, heartbeatServiceHandle } from "./heartbeat.js";

export const manifest: Manifest = {
	id: "heartbeat",
	name: "Heartbeat",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	dependsOn: ["session-orchestrator"],
	activation: "eager",
	contributes: { services: ["heartbeat"] },
};

// Module-scoped store for deactivate (the extension object is created once).
const store: { service: { stopAll: () => void } | null } = { service: null };

export const extension: Extension = {
	manifest,
	async activate(host: HostAPI) {
		const orchestrator = host.getService<SessionOrchestrator>(sessionOrchestratorHandle);
		const storage = host.storage("heartbeat");
		const logger = host.logger;

		const service = createHeartbeatService({ storage, orchestrator, logger });

		// Reconcile stale runs + arm enabled workspaces on boot.
		await service.startAll();
		store.service = service;

		host.provideService(heartbeatServiceHandle, service);

		host.logger.info("heartbeat extension activated");
	},
	deactivate() {
		// Stop schedulers so no new fires happen during shutdown.
		store.service?.stopAll();
		store.service = null;
	},
};
