import type { Manifest } from "@dispatch/kernel";
import type { CustomField, StatField } from "@dispatch/ui-contract";
import { describe, expect, it } from "vitest";
import { buildLoadedExtensionsSpec, TABLE_RENDERER_ID, type TablePayload } from "./spec.js";

function fakeManifest(
	id: string,
	name: string,
	version: string,
	extra: Partial<Manifest> = {},
): Manifest {
	return {
		id,
		name,
		version,
		apiVersion: "^0.1.0",
		trust: "bundled",
		...extra,
	};
}

function tablePayload(field: unknown): TablePayload {
	const custom = field as CustomField;
	expect(custom.kind).toBe("custom");
	expect(custom.rendererId).toBe(TABLE_RENDERER_ID);
	return custom.payload as TablePayload;
}

describe("buildLoadedExtensionsSpec", () => {
	it("returns a count stat of '0' and an empty table for empty manifests", () => {
		const spec = buildLoadedExtensionsSpec([]);

		expect(spec.id).toBe("loaded-extensions");
		expect(spec.region).toBe("side");
		expect(spec.title).toBe("Loaded Extensions");
		expect(spec.fields).toHaveLength(2);
		expect(spec.fields[0]).toEqual({
			kind: "stat",
			label: "Loaded",
			value: "0",
		});
		expect(tablePayload(spec.fields[1]).rows).toEqual([]);
	});

	it("returns a count stat plus ONE table field with a row per manifest (CR-1)", () => {
		const manifests = [
			fakeManifest("alpha", "Alpha", "1.0.0"),
			fakeManifest("beta", "Beta", "2.3.1", { trust: "external", activation: "lazy" }),
			fakeManifest("gamma", "Gamma", "0.5.0", { trust: "local" }),
		];

		const spec = buildLoadedExtensionsSpec(manifests);

		expect(spec.fields).toHaveLength(2);
		expect(spec.fields[0]).toEqual({
			kind: "stat",
			label: "Loaded",
			value: "3",
		});

		const payload = tablePayload(spec.fields[1]);
		expect(payload.columns).toEqual(["Name", "Version", "Trust", "Activation"]);
		expect(payload.rows).toEqual([
			["Alpha", "1.0.0", "bundled", "eager"],
			["Beta", "2.3.1", "external", "lazy"],
			["Gamma", "0.5.0", "local", "eager"],
		]);
	});

	it("every row aligns cell-for-cell to the columns", () => {
		const spec = buildLoadedExtensionsSpec([fakeManifest("a", "A", "1.0.0")]);
		const payload = tablePayload(spec.fields[1]);
		for (const row of payload.rows) {
			expect(row).toHaveLength(payload.columns.length);
		}
	});

	it("preserves input order of manifests", () => {
		const manifests = [
			fakeManifest("z-last", "Z Last", "1.0.0"),
			fakeManifest("a-first", "A First", "2.0.0"),
		];

		const spec = buildLoadedExtensionsSpec(manifests);

		const payload = tablePayload(spec.fields[1]);
		expect(payload.rows.map((r) => r[0])).toEqual(["Z Last", "A First"]);
	});

	it("sets the surface id, region, and title correctly", () => {
		const spec = buildLoadedExtensionsSpec([]);

		expect(spec.id).toBe("loaded-extensions");
		expect(spec.region).toBe("side");
		expect(spec.title).toBe("Loaded Extensions");
	});

	it("defaults a missing activation to 'eager' (the declared manifest default)", () => {
		const spec = buildLoadedExtensionsSpec([fakeManifest("my-ext", "My Extension", "3.2.1")]);
		const payload = tablePayload(spec.fields[1]);
		expect(payload.rows[0]).toEqual(["My Extension", "3.2.1", "bundled", "eager"]);
	});

	it("the count stat remains a plain stat (graceful-skip clients still see it)", () => {
		const spec = buildLoadedExtensionsSpec([fakeManifest("a", "A", "1.0.0")]);
		expect((spec.fields[0] as StatField).kind).toBe("stat");
	});
});
