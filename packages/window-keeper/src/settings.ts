/**
 * window-keeper settings — the persisted per-provider toggles and the typed
 * service the HTTP routes consume.
 *
 * One document for the whole backend, stored in the `window-keeper` namespace
 * under `config:global`. Both providers are ON by default.
 */
import { defineService, type ServiceHandle, type StorageNamespace } from "@dispatch/kernel";
import type { WindowKeeperConfigResponse } from "@dispatch/transport-contract";
import { KEEPER_PROFILES } from "./profiles.js";

export interface WindowKeeperSettings {
  readonly claude: boolean;
  readonly codex: boolean;
}

export const DEFAULT_WINDOW_KEEPER_SETTINGS: WindowKeeperSettings = { claude: true, codex: true };

export const WINDOW_KEEPER_SETTINGS_KEY = "config:global";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Pure. Garbage / null → defaults; a field that is not a boolean → its default. */
export function parseWindowKeeperSettings(raw: string | null): WindowKeeperSettings {
  if (raw === null) return DEFAULT_WINDOW_KEEPER_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_WINDOW_KEEPER_SETTINGS;
  }
  if (!isRecord(parsed)) return DEFAULT_WINDOW_KEEPER_SETTINGS;
  return {
    claude:
      typeof parsed.claude === "boolean" ? parsed.claude : DEFAULT_WINDOW_KEEPER_SETTINGS.claude,
    codex: typeof parsed.codex === "boolean" ? parsed.codex : DEFAULT_WINDOW_KEEPER_SETTINGS.codex,
  };
}

export type WindowKeeperUpdateResult =
  | { readonly ok: true; readonly settings: WindowKeeperSettings }
  | { readonly ok: false; readonly error: "invalid-provider" | "invalid-enabled" };

/** Pure. `provider` is checked before `enabled`. */
export function applyWindowKeeperUpdate(
  current: WindowKeeperSettings,
  update: { readonly provider: unknown; readonly enabled: unknown },
): WindowKeeperUpdateResult {
  const provider = update.provider;
  if (provider !== "claude" && provider !== "codex") {
    return { ok: false, error: "invalid-provider" };
  }
  if (typeof update.enabled !== "boolean") {
    return { ok: false, error: "invalid-enabled" };
  }
  return { ok: true, settings: { ...current, [provider]: update.enabled } };
}

/** Pure. Settings → wire response, in KEEPER_PROFILES order, labels from the profiles. */
export function toWindowKeeperConfig(settings: WindowKeeperSettings): WindowKeeperConfigResponse {
  return {
    providers: KEEPER_PROFILES.map((profile) => ({
      id: profile.id,
      label: profile.label,
      enabled: settings[profile.id],
    })),
  };
}

export interface WindowKeeperService {
  readonly getConfig: () => Promise<WindowKeeperConfigResponse>;
  /** Validate, persist, then start/stop the affected keeper. Rejections are values. */
  readonly setEnabled: (update: {
    readonly provider: unknown;
    readonly enabled: unknown;
  }) => Promise<
    | { readonly ok: true; readonly config: WindowKeeperConfigResponse }
    | { readonly ok: false; readonly error: "invalid-provider" | "invalid-enabled" }
  >;
}

export const windowKeeperServiceHandle: ServiceHandle<WindowKeeperService> =
  defineService<WindowKeeperService>("window-keeper/service");

export interface WindowKeeperServiceDeps {
  readonly storage: StorageNamespace;
  /** Called after a successful, persisted update with the new settings. */
  readonly onSettings: (settings: WindowKeeperSettings) => void;
}

/**
 * Storage-backed settings service. `getConfig` reads storage on every call, so
 * an external writer is reflected without a restart.
 */
export function createWindowKeeperService(deps: WindowKeeperServiceDeps): WindowKeeperService {
  async function readSettings(): Promise<WindowKeeperSettings> {
    return parseWindowKeeperSettings(await deps.storage.get(WINDOW_KEEPER_SETTINGS_KEY));
  }
  return {
    async getConfig(): Promise<WindowKeeperConfigResponse> {
      return toWindowKeeperConfig(await readSettings());
    },
    async setEnabled(update) {
      const current = await readSettings();
      const result = applyWindowKeeperUpdate(current, update);
      if (!result.ok) return result;
      await deps.storage.set(WINDOW_KEEPER_SETTINGS_KEY, JSON.stringify(result.settings));
      deps.onSettings(result.settings);
      return { ok: true, config: toWindowKeeperConfig(result.settings) };
    },
  };
}
