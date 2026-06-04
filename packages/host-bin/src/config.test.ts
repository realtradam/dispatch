import { describe, expect, it } from "vitest";
import { configMapToAccess, envToConfigMap } from "./config.js";

describe("envToConfigMap", () => {
	it("maps DISPATCH_API_KEY to provider.openai-compat.apiKey", () => {
		const result = envToConfigMap({ DISPATCH_API_KEY: "sk-test-123" });
		expect(result["provider.openai-compat.apiKey"]).toBe("sk-test-123");
	});

	it("maps DISPATCH_BASE_URL to provider.openai-compat.baseURL", () => {
		const result = envToConfigMap({ DISPATCH_BASE_URL: "https://custom.api/v1" });
		expect(result["provider.openai-compat.baseURL"]).toBe("https://custom.api/v1");
	});

	it("maps DISPATCH_MODEL to provider.openai-compat.model", () => {
		const result = envToConfigMap({ DISPATCH_MODEL: "gpt-4" });
		expect(result["provider.openai-compat.model"]).toBe("gpt-4");
	});

	it("maps all three env vars together", () => {
		const result = envToConfigMap({
			DISPATCH_API_KEY: "key",
			DISPATCH_BASE_URL: "https://api.example.com",
			DISPATCH_MODEL: "my-model",
		});
		expect(result).toEqual({
			"provider.openai-compat.apiKey": "key",
			"provider.openai-compat.baseURL": "https://api.example.com",
			"provider.openai-compat.model": "my-model",
		});
	});

	it("returns empty map when no relevant env vars are set", () => {
		const result = envToConfigMap({ HOME: "/home/user", PATH: "/usr/bin" });
		expect(result).toEqual({});
	});

	it("skips undefined env vars", () => {
		const result = envToConfigMap({ DISPATCH_API_KEY: undefined });
		expect(result).toEqual({});
	});

	it("includes only set vars when some are missing", () => {
		const result = envToConfigMap({
			DISPATCH_API_KEY: "key",
			DISPATCH_MODEL: undefined,
		});
		expect(result).toEqual({
			"provider.openai-compat.apiKey": "key",
		});
		expect(result["provider.openai-compat.baseURL"]).toBeUndefined();
		expect(result["provider.openai-compat.model"]).toBeUndefined();
	});
});

describe("configMapToAccess", () => {
	it("returns value for existing key", () => {
		const access = configMapToAccess({ "provider.openai-compat.apiKey": "sk-123" });
		expect(access.get("provider.openai-compat.apiKey")).toBe("sk-123");
	});

	it("returns undefined for missing key", () => {
		const access = configMapToAccess({});
		expect(access.get("nonexistent")).toBeUndefined();
	});

	it("returns typed value", () => {
		const access = configMapToAccess({ "some.number": 42 });
		expect(access.get<number>("some.number")).toBe(42);
	});

	it("getAll returns the full map", () => {
		const map = { a: 1, b: "two" };
		const access = configMapToAccess(map);
		expect(access.getAll()).toEqual(map);
	});
});
