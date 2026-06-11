import { describe, expect, it } from "vitest";
import { findRoot } from "./root.js";

describe("root", () => {
	it("findRoot returns nearest marker ancestor bounded by cwd", async () => {
		const existingFiles = new Set([
			"/project/src/components/tsconfig.json",
			"/project/tsconfig.json",
		]);

		const result = await findRoot(
			"/project/src/components/widgets",
			"/project",
			["tsconfig.json"],
			async (path) => existingFiles.has(path),
		);

		expect(result).toBe("/project/src/components");
	});

	it("falls back to cwd", async () => {
		const result = await findRoot(
			"/project/src/deep/nested",
			"/project",
			["tsconfig.json"],
			async () => false,
		);

		expect(result).toBe("/project");
	});

	it("finds marker at start directory", async () => {
		const existingFiles = new Set(["/project/tsconfig.json"]);

		const result = await findRoot("/project", "/project", ["tsconfig.json"], async (path) =>
			existingFiles.has(path),
		);

		expect(result).toBe("/project");
	});

	it("respects cwd boundary", async () => {
		const existingFiles = new Set(["/tsconfig.json"]);

		const result = await findRoot("/project/src", "/project", ["tsconfig.json"], async (path) =>
			existingFiles.has(path),
		);

		expect(result).toBe("/project");
	});
});
