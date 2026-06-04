import { describe, expect, it } from "vitest";
import { isApiVersionCompatible } from "./version.js";

describe("isApiVersionCompatible", () => {
	describe("wildcard", () => {
		it("matches any version", () => {
			expect(isApiVersionCompatible("*", "0.1.0")).toBe(true);
			expect(isApiVersionCompatible("*", "1.0.0")).toBe(true);
			expect(isApiVersionCompatible("*", "99.99.99")).toBe(true);
		});
	});

	describe("exact match", () => {
		it("matches identical version", () => {
			expect(isApiVersionCompatible("0.1.0", "0.1.0")).toBe(true);
		});

		it("rejects different patch", () => {
			expect(isApiVersionCompatible("0.1.0", "0.1.1")).toBe(false);
		});

		it("rejects different minor", () => {
			expect(isApiVersionCompatible("0.1.0", "0.2.0")).toBe(false);
		});

		it("rejects different major", () => {
			expect(isApiVersionCompatible("1.0.0", "2.0.0")).toBe(false);
		});
	});

	describe("caret range (^)", () => {
		it("0.x: allows same minor, higher patch", () => {
			expect(isApiVersionCompatible("^0.1.0", "0.1.0")).toBe(true);
			expect(isApiVersionCompatible("^0.1.0", "0.1.5")).toBe(true);
			expect(isApiVersionCompatible("^0.1.0", "0.1.99")).toBe(true);
		});

		it("0.x: rejects different minor", () => {
			expect(isApiVersionCompatible("^0.1.0", "0.2.0")).toBe(false);
			expect(isApiVersionCompatible("^0.1.0", "0.0.9")).toBe(false);
		});

		it("0.x: rejects different major", () => {
			expect(isApiVersionCompatible("^0.1.0", "1.0.0")).toBe(false);
		});

		it("1.x+: allows same major, higher minor/patch", () => {
			expect(isApiVersionCompatible("^1.2.0", "1.2.0")).toBe(true);
			expect(isApiVersionCompatible("^1.2.0", "1.3.0")).toBe(true);
			expect(isApiVersionCompatible("^1.2.0", "1.99.0")).toBe(true);
		});

		it("1.x+: rejects next major", () => {
			expect(isApiVersionCompatible("^1.2.0", "2.0.0")).toBe(false);
		});

		it("rejects below minimum", () => {
			expect(isApiVersionCompatible("^1.2.3", "1.2.2")).toBe(false);
			expect(isApiVersionCompatible("^1.2.3", "1.1.9")).toBe(false);
		});
	});

	describe("tilde range (~)", () => {
		it("allows same major.minor, higher patch", () => {
			expect(isApiVersionCompatible("~0.1.0", "0.1.0")).toBe(true);
			expect(isApiVersionCompatible("~0.1.0", "0.1.5")).toBe(true);
		});

		it("rejects different minor", () => {
			expect(isApiVersionCompatible("~0.1.0", "0.2.0")).toBe(false);
		});

		it("rejects below minimum", () => {
			expect(isApiVersionCompatible("~1.2.3", "1.2.2")).toBe(false);
		});
	});

	describe(">= range", () => {
		it("allows equal or higher", () => {
			expect(isApiVersionCompatible(">=0.1.0", "0.1.0")).toBe(true);
			expect(isApiVersionCompatible(">=0.1.0", "0.2.0")).toBe(true);
			expect(isApiVersionCompatible(">=0.1.0", "1.0.0")).toBe(true);
		});

		it("rejects below minimum", () => {
			expect(isApiVersionCompatible(">=0.2.0", "0.1.0")).toBe(false);
			expect(isApiVersionCompatible(">=1.0.0", "0.9.9")).toBe(false);
		});
	});

	describe("invalid input", () => {
		it("throws on invalid kernel version", () => {
			expect(() => isApiVersionCompatible("^0.1.0", "abc")).toThrow(/invalid semver/i);
		});

		it("throws on invalid range version", () => {
			expect(() => isApiVersionCompatible("not-a-range", "0.1.0")).toThrow(/invalid semver/i);
		});
	});
});
