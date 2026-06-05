import { describe, expect, it } from "vitest";
import { formatCatalog } from "./catalog.js";

describe("formatCatalog", () => {
	it("formats a single model", () => {
		expect(formatCatalog({ models: ["openai/gpt-4"] })).toBe("openai/gpt-4");
	});

	it("formats multiple models one per line", () => {
		expect(formatCatalog({ models: ["openai/gpt-4", "anthropic/claude-3", "local/llama"] })).toBe(
			"openai/gpt-4\nanthropic/claude-3\nlocal/llama",
		);
	});

	it("returns empty string for empty models", () => {
		expect(formatCatalog({ models: [] })).toBe("");
	});
});
