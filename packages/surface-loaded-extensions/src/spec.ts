import type { Manifest } from "@dispatch/kernel";
import type { StatField, SurfaceSpec } from "@dispatch/ui-contract";

/**
 * Pure core — builds the SurfaceSpec for the loaded-extensions surface.
 * Zero I/O, zero ambient state. Decision logic only: input → output.
 */
export function buildLoadedExtensionsSpec(manifests: readonly Manifest[]): SurfaceSpec {
	const fields: StatField[] = [{ kind: "stat", label: "Loaded", value: String(manifests.length) }];

	for (const manifest of manifests) {
		fields.push({
			kind: "stat",
			label: manifest.name,
			value: manifest.version,
		});
	}

	return {
		id: "loaded-extensions",
		region: "side",
		title: "Loaded Extensions",
		fields,
	};
}
