import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import type { SurfaceProvider } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import { buildLoadedExtensionsSpec } from "./spec.js";

export const manifest: Manifest = {
	id: "surface-loaded-extensions",
	name: "Loaded Extensions Surface",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	activation: "eager",
	dependsOn: ["surface-registry"],
	contributes: { services: [] },
};

export function createLoadedExtensionsExtension(): Extension {
	let dispose: (() => void) | undefined;

	return {
		manifest,
		activate(host: HostAPI) {
			const registry = host.getService(surfaceRegistryHandle);

			const provider: SurfaceProvider = {
				catalogEntry: {
					id: "loaded-extensions",
					region: "side",
					title: "Loaded Extensions",
				},
				getSpec() {
					return buildLoadedExtensionsSpec(host.getExtensions());
				},
				invoke() {},
			};

			dispose = registry.register(provider);
		},
		deactivate() {
			dispose?.();
		},
	};
}
