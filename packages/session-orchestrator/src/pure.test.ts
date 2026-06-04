import type { ProviderContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
	buildUserMessage,
	defaultDispatchPolicy,
	generateTurnId,
	selectFirstProvider,
} from "./pure.js";

describe("buildUserMessage", () => {
	it("creates a user message with a single text chunk", () => {
		const msg = buildUserMessage("hello world");
		expect(msg.role).toBe("user");
		expect(msg.chunks).toHaveLength(1);
		expect(msg.chunks[0]).toEqual({ type: "text", text: "hello world" });
	});

	it("preserves empty text", () => {
		const msg = buildUserMessage("");
		expect(msg.role).toBe("user");
		expect(msg.chunks[0]).toEqual({ type: "text", text: "" });
	});
});

describe("selectFirstProvider", () => {
	it("returns the first provider from a non-empty map", () => {
		const provider: ProviderContract = {
			id: "test-provider",
			stream: async function* () {},
		};
		const providers = new Map<string, ProviderContract>();
		providers.set("test-provider", provider);

		expect(selectFirstProvider(providers)).toBe(provider);
	});

	it("throws when the map is empty", () => {
		const providers = new Map<string, ProviderContract>();
		expect(() => selectFirstProvider(providers)).toThrow("No providers registered");
	});

	it("returns the first inserted provider when multiple exist", () => {
		const first: ProviderContract = { id: "first", stream: async function* () {} };
		const second: ProviderContract = { id: "second", stream: async function* () {} };
		const providers = new Map<string, ProviderContract>();
		providers.set("first", first);
		providers.set("second", second);

		expect(selectFirstProvider(providers).id).toBe("first");
	});
});

describe("defaultDispatchPolicy", () => {
	it("returns maxConcurrent: 1, eager: true", () => {
		expect(defaultDispatchPolicy()).toEqual({ maxConcurrent: 1, eager: true });
	});
});

describe("generateTurnId", () => {
	it("returns a string starting with 'turn-'", () => {
		const id = generateTurnId();
		expect(id).toMatch(/^turn-/);
	});

	it("returns unique ids", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateTurnId()));
		expect(ids.size).toBe(100);
	});
});
