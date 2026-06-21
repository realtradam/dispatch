import { describe, expect, it } from "vitest";
import { resolveUmansConfig } from "./resolver.js";

describe("resolveUmansConfig", () => {
	it("activate uses UMANS_BASE_URL override when set (default otherwise)", () => {
		const override = resolveUmansConfig(
			{ UMANS_API_KEY: "sk-test", UMANS_BASE_URL: "https://custom.example.com/v1" },
			undefined,
		);
		expect(override?.baseURL).toBe("https://custom.example.com/v1");

		const fallback = resolveUmansConfig({ UMANS_API_KEY: "sk-test" }, undefined);
		expect(fallback?.baseURL).toBe("https://api.code.umans.ai/v1");
	});

	it('activate uses config provider.umans.model → UMANS_MODEL → "umans-coder" resolution', () => {
		// config wins over env + default
		const fromConfig = resolveUmansConfig(
			{ UMANS_API_KEY: "sk-test", UMANS_MODEL: "env-model" },
			"config-model",
		);
		expect(fromConfig?.model).toBe("config-model");

		// env wins when config is absent
		const fromEnv = resolveUmansConfig(
			{ UMANS_API_KEY: "sk-test", UMANS_MODEL: "env-model" },
			undefined,
		);
		expect(fromEnv?.model).toBe("env-model");

		// default when neither is set
		const fromDefault = resolveUmansConfig({ UMANS_API_KEY: "sk-test" }, undefined);
		expect(fromDefault?.model).toBe("umans-coder");
	});

	it("returns null when UMANS_API_KEY is unset", () => {
		expect(resolveUmansConfig({}, undefined)).toBeNull();
	});

	it("returns null when UMANS_API_KEY is empty string", () => {
		expect(resolveUmansConfig({ UMANS_API_KEY: "" }, undefined)).toBeNull();
	});
});
