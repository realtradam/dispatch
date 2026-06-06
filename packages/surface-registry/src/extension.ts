import type { Extension, Manifest } from "@dispatch/kernel";
import { createSurfaceRegistry } from "./registry.js";
import { surfaceRegistryHandle } from "./service.js";

export const manifest: Manifest = {
	id: "surface-registry",
	name: "Surface Registry",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	activation: "eager",
	contributes: { services: ["surface-registry/registry"] },
};

export function createSurfaceRegistryExtension(): Extension {
	return {
		manifest,
		activate(host) {
			const registry = createSurfaceRegistry();
			host.provideService(surfaceRegistryHandle, registry);
		},
	};
}
