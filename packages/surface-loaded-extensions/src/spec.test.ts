import type { Manifest } from "@dispatch/kernel";
import type { StatField } from "@dispatch/ui-contract";
import { describe, expect, it } from "vitest";
import { buildLoadedExtensionsSpec } from "./spec.js";

function fakeManifest(id: string, name: string, version: string): Manifest {
	return {
		id,
		name,
		version,
		apiVersion: "^0.1.0",
		trust: "bundled",
	};
}

describe("buildLoadedExtensionsSpec", () => {
	it("returns a count stat of '0' and no extension stats for empty manifests", () => {
		const spec = buildLoadedExtensionsSpec([]);

		expect(spec.id).toBe("loaded-extensions");
		expect(spec.region).toBe("side");
		expect(spec.title).toBe("Loaded Extensions");
		expect(spec.fields).toHaveLength(1);
		expect(spec.fields[0]).toEqual({
			kind: "stat",
			label: "Loaded",
			value: "0",
		});
	});

	it("returns a count stat plus one stat per manifest in order", () => {
		const manifests = [
			fakeManifest("alpha", "Alpha", "1.0.0"),
			fakeManifest("beta", "Beta", "2.3.1"),
			fakeManifest("gamma", "Gamma", "0.5.0"),
		];

		const spec = buildLoadedExtensionsSpec(manifests);

		expect(spec.fields).toHaveLength(4);
		expect(spec.fields[0]).toEqual({
			kind: "stat",
			label: "Loaded",
			value: "3",
		});
		expect(spec.fields[1]).toEqual({
			kind: "stat",
			label: "Alpha",
			value: "1.0.0",
		});
		expect(spec.fields[2]).toEqual({
			kind: "stat",
			label: "Beta",
			value: "2.3.1",
		});
		expect(spec.fields[3]).toEqual({
			kind: "stat",
			label: "Gamma",
			value: "0.5.0",
		});
	});

	it("preserves input order of manifests", () => {
		const manifests = [
			fakeManifest("z-last", "Z Last", "1.0.0"),
			fakeManifest("a-first", "A First", "2.0.0"),
		];

		const spec = buildLoadedExtensionsSpec(manifests);

		expect((spec.fields[1] as StatField).label).toBe("Z Last");
		expect((spec.fields[2] as StatField).label).toBe("A First");
	});

	it("sets the surface id, region, and title correctly", () => {
		const spec = buildLoadedExtensionsSpec([]);

		expect(spec.id).toBe("loaded-extensions");
		expect(spec.region).toBe("side");
		expect(spec.title).toBe("Loaded Extensions");
	});

	it("uses manifest.name as label and manifest.version as value", () => {
		const manifests = [fakeManifest("my-ext", "My Extension", "3.2.1")];

		const spec = buildLoadedExtensionsSpec(manifests);

		expect(spec.fields[1]).toEqual({
			kind: "stat",
			label: "My Extension",
			value: "3.2.1",
		});
	});
});
