import { describe, expect, it } from "vitest";
import { validateUrl } from "./validate.js";

describe("validateUrl", () => {
	it("accepts valid URL", () => {
		const result = validateUrl({ url: "https://www.youtube.com/watch?v=abc123" });
		expect(result).toBe("https://www.youtube.com/watch?v=abc123");
	});

	it("rejects missing url", () => {
		const result = validateUrl({ query: "no url here" });
		expect(typeof result).toBe("object");
		if (typeof result === "object") {
			expect(result.error).toContain("url");
		}
	});

	it("rejects empty url", () => {
		const empty = validateUrl({ url: "" });
		expect(typeof empty).toBe("object");
		if (typeof empty === "object") {
			expect(empty.error).toContain("url");
		}
		const whitespace = validateUrl({ url: "   " });
		expect(typeof whitespace).toBe("object");
	});

	it("rejects null/non-object args", () => {
		expect(typeof validateUrl(null)).toBe("object");
		expect(typeof validateUrl(undefined)).toBe("object");
		expect(typeof validateUrl("string")).toBe("object");
		expect(typeof validateUrl(42)).toBe("object");
		expect(typeof validateUrl(true)).toBe("object");
	});
});
