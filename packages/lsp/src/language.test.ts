import { describe, expect, it } from "vitest";
import { languageId } from "./language.js";

describe("language", () => {
	it("maps .ts to typescript", () => {
		expect(languageId("file.ts")).toBe("typescript");
	});

	it("maps .tsx to typescriptreact", () => {
		expect(languageId("file.tsx")).toBe("typescriptreact");
	});

	it("maps .js to javascript", () => {
		expect(languageId("file.js")).toBe("javascript");
	});

	it("maps .luau to luau", () => {
		expect(languageId("file.luau")).toBe("luau");
	});

	it("returns unknown for unrecognized extensions", () => {
		expect(languageId("file.xyz")).toBe("unknown");
	});

	it("returns unknown for files without extensions", () => {
		expect(languageId("Makefile")).toBe("unknown");
	});
});
