// Persisted ntfy config — single global JSON blob under one settings key.
//
// One global config (no per-user split): the rest of Dispatch's settings
// table is global today (cf. `title_model_*`, `perm_*`), so notification
// config follows the same pattern.

import { deleteSetting, getSetting, setSetting } from "../db/settings.js";
import type { NotificationEventType, NtfyConfig } from "./types.js";
import { NTFY_DEFAULT_EVENTS, NTFY_EVENT_TYPES } from "./types.js";

export const NTFY_CONFIG_KEY = "ntfy_config";

/** Defaults returned when nothing is persisted yet. */
export function defaultNtfyConfig(): NtfyConfig {
	return {
		enabled: false,
		topic: "",
		authToken: "",
		events: { ...NTFY_DEFAULT_EVENTS },
		notifySubagents: false,
	};
}

/**
 * Normalize an arbitrary parsed JSON value into a complete `NtfyConfig`.
 * Tolerant of missing / unexpected fields so a config from an older build
 * never throws — missing event toggles fall back to defaults.
 */
export function normalizeNtfyConfig(raw: unknown): NtfyConfig {
	const base = defaultNtfyConfig();
	if (!raw || typeof raw !== "object") return base;
	const obj = raw as Record<string, unknown>;
	const out: NtfyConfig = {
		enabled: typeof obj.enabled === "boolean" ? obj.enabled : base.enabled,
		topic: typeof obj.topic === "string" ? obj.topic : base.topic,
		authToken: typeof obj.authToken === "string" ? obj.authToken : base.authToken,
		events: { ...base.events },
		notifySubagents:
			typeof obj.notifySubagents === "boolean" ? obj.notifySubagents : base.notifySubagents,
	};
	const rawEvents = obj.events;
	if (rawEvents && typeof rawEvents === "object") {
		const evObj = rawEvents as Record<string, unknown>;
		for (const key of NTFY_EVENT_TYPES) {
			const v = evObj[key];
			if (typeof v === "boolean") out.events[key as NotificationEventType] = v;
		}
	}
	return out;
}

/** Load the persisted config (or defaults if none/corrupt). */
export function loadNtfyConfig(): NtfyConfig {
	const raw = getSetting(NTFY_CONFIG_KEY);
	if (!raw) return defaultNtfyConfig();
	try {
		return normalizeNtfyConfig(JSON.parse(raw));
	} catch {
		return defaultNtfyConfig();
	}
}

/** Persist a complete config (after server-side normalization). */
export function saveNtfyConfig(config: NtfyConfig): void {
	const normalized = normalizeNtfyConfig(config);
	setSetting(NTFY_CONFIG_KEY, JSON.stringify(normalized));
}

/** Wipe the persisted config (revert to defaults on next load). */
export function clearNtfyConfig(): void {
	deleteSetting(NTFY_CONFIG_KEY);
}

/** Strip the auth token from a config before returning it over the API. */
export function redactNtfyConfig(config: NtfyConfig): NtfyConfig & { hasAuthToken: boolean } {
	return { ...config, authToken: "", hasAuthToken: config.authToken.trim().length > 0 };
}
