import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory fake for the settings table — mounted before the module under
// test is imported (vi.mock is hoisted).
const fakeSettings = new Map<string, string>();

vi.mock("../../src/db/settings.js", () => ({
	getSetting: vi.fn((key: string) => fakeSettings.get(key) ?? null),
	setSetting: vi.fn((key: string, value: string) => {
		fakeSettings.set(key, value);
	}),
	deleteSetting: vi.fn((key: string) => {
		fakeSettings.delete(key);
	}),
}));

const {
	clearNtfyConfig,
	defaultNtfyConfig,
	loadNtfyConfig,
	normalizeNtfyConfig,
	NTFY_CONFIG_KEY,
	redactNtfyConfig,
	saveNtfyConfig,
} = await import("../../src/notifications/config.js");

describe("defaultNtfyConfig", () => {
	it("disables notifications and ships sane per-event defaults", () => {
		const cfg = defaultNtfyConfig();
		expect(cfg.enabled).toBe(false);
		expect(cfg.topicUrl).toBe("");
		expect(cfg.authToken).toBe("");
		expect(cfg.events["turn-completed"]).toBe(true);
		expect(cfg.events["turn-error"]).toBe(true);
		expect(cfg.events["permission-required"]).toBe(true);
		expect(cfg.events["agent-spawned"]).toBe(false);
	});
});

describe("normalizeNtfyConfig", () => {
	it("returns defaults for non-object input", () => {
		expect(normalizeNtfyConfig(null)).toEqual(defaultNtfyConfig());
		expect(normalizeNtfyConfig(undefined)).toEqual(defaultNtfyConfig());
		expect(normalizeNtfyConfig(42)).toEqual(defaultNtfyConfig());
	});

	it("fills in missing event toggles with defaults (newly-added types default OFF)", () => {
		const normalized = normalizeNtfyConfig({
			enabled: true,
			topicUrl: "https://ntfy.sh/x",
			events: { "turn-completed": false },
		});
		expect(normalized.events["turn-completed"]).toBe(false);
		// Defaults preserved for fields the persisted blob doesn't have.
		expect(normalized.events["turn-error"]).toBe(true);
		expect(normalized.events["agent-spawned"]).toBe(false);
	});

	it("ignores extraneous fields and wrong-typed values", () => {
		const normalized = normalizeNtfyConfig({
			enabled: "yes", // wrong type ⇒ default
			topicUrl: 42, // wrong type ⇒ default
			authToken: null, // wrong type ⇒ default
			events: { "turn-completed": "no", bogus: true },
			extra: "ignored",
		});
		expect(normalized.enabled).toBe(false);
		expect(normalized.topicUrl).toBe("");
		expect(normalized.authToken).toBe("");
		expect(normalized.events["turn-completed"]).toBe(true); // default kept
		expect((normalized.events as Record<string, boolean>).bogus).toBeUndefined();
	});
});

describe("load/save round-trip", () => {
	beforeEach(() => {
		fakeSettings.clear();
	});

	it("returns defaults when nothing is persisted", () => {
		expect(loadNtfyConfig()).toEqual(defaultNtfyConfig());
	});

	it("round-trips a complete config", () => {
		const cfg = {
			enabled: true,
			topicUrl: "https://ntfy.sh/team",
			authToken: "tk_abc",
			events: {
				"turn-completed": false,
				"turn-error": true,
				"permission-required": true,
				"agent-spawned": true,
			},
		} as const;
		saveNtfyConfig({ ...cfg });
		const loaded = loadNtfyConfig();
		expect(loaded).toEqual(cfg);
		// Persisted as a JSON string under the documented key.
		expect(fakeSettings.has(NTFY_CONFIG_KEY)).toBe(true);
	});

	it("returns defaults when stored JSON is corrupt", () => {
		fakeSettings.set(NTFY_CONFIG_KEY, "{ not json");
		expect(loadNtfyConfig()).toEqual(defaultNtfyConfig());
	});

	it("clearNtfyConfig removes the persisted entry", () => {
		saveNtfyConfig({ ...defaultNtfyConfig(), enabled: true, topicUrl: "https://ntfy.sh/x" });
		expect(fakeSettings.has(NTFY_CONFIG_KEY)).toBe(true);
		clearNtfyConfig();
		expect(fakeSettings.has(NTFY_CONFIG_KEY)).toBe(false);
	});
});

describe("redactNtfyConfig", () => {
	it("strips authToken and surfaces a hasAuthToken flag", () => {
		const cfg = { ...defaultNtfyConfig(), authToken: "tk_secret" };
		const redacted = redactNtfyConfig(cfg);
		expect(redacted.authToken).toBe("");
		expect(redacted.hasAuthToken).toBe(true);
	});

	it("hasAuthToken is false for blank tokens", () => {
		expect(redactNtfyConfig({ ...defaultNtfyConfig(), authToken: "" }).hasAuthToken).toBe(false);
		expect(redactNtfyConfig({ ...defaultNtfyConfig(), authToken: "   " }).hasAuthToken).toBe(false);
	});
});
