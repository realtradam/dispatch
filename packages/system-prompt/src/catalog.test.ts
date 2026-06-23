import { describe, expect, it } from "vitest";
import { getVariableCatalog } from "./catalog.js";

describe("catalog", () => {
	it("lists all fixed variables", () => {
		const catalog = getVariableCatalog();
		const keys = catalog.map((v) => `${v.type}:${v.name}`);

		expect(keys).toContain("system:time");
		expect(keys).toContain("system:date");
		expect(keys).toContain("system:os");
		expect(keys).toContain("system:hostname");
		expect(keys).toContain("prompt:cwd");
		expect(keys).toContain("prompt:model");
		expect(keys).toContain("prompt:conversation_id");
		expect(keys).toContain("git:branch");
		expect(keys).toContain("git:status");
	});

	it("marks the file type as dynamic", () => {
		const fileVar = getVariableCatalog().find((v) => v.type === "file");
		expect(fileVar).toBeDefined();
		expect(fileVar?.dynamic).toBe(true);
	});

	it("every entry has a description", () => {
		for (const v of getVariableCatalog()) {
			expect(v.description.length).toBeGreaterThan(0);
		}
	});
});
