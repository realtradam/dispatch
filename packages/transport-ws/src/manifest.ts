import type { Manifest } from "@dispatch/kernel";

export const manifest: Manifest = {
	id: "transport-ws",
	name: "Transport WebSocket",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	dependsOn: ["surface-registry"],
	capabilities: { network: true },
	contributes: { routes: ["/ws/surfaces"] },
	activation: "eager",
};
