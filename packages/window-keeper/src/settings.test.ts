import type { StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import {
  applyWindowKeeperUpdate,
  createWindowKeeperService,
  DEFAULT_WINDOW_KEEPER_SETTINGS,
  parseWindowKeeperSettings,
  toWindowKeeperConfig,
  WINDOW_KEEPER_SETTINGS_KEY,
  type WindowKeeperSettings,
} from "./settings.js";

function fakeStorage(): { storage: StorageNamespace; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { storage: storageFromMap(data), data };
}

describe("parseWindowKeeperSettings", () => {
  it("returns defaults for null, garbage, and non-objects", () => {
    for (const raw of [null, "", "not json", "null", "42", '"str"', "[]", "[true]"]) {
      expect(parseWindowKeeperSettings(raw)).toEqual(DEFAULT_WINDOW_KEEPER_SETTINGS);
    }
  });

  it("reads a stored document, filling missing/non-boolean fields with defaults", () => {
    expect(parseWindowKeeperSettings(JSON.stringify({ claude: false, codex: true }))).toEqual({
      claude: false,
      codex: true,
    });
    expect(parseWindowKeeperSettings(JSON.stringify({ claude: false }))).toEqual({
      claude: false,
      codex: true,
    });
    expect(parseWindowKeeperSettings(JSON.stringify({ codex: false }))).toEqual({
      claude: true,
      codex: false,
    });
    expect(parseWindowKeeperSettings(JSON.stringify({ claude: "no", codex: 1 }))).toEqual(
      DEFAULT_WINDOW_KEEPER_SETTINGS,
    );
  });

  it("defaults both providers to on", () => {
    expect(DEFAULT_WINDOW_KEEPER_SETTINGS).toEqual({ claude: true, codex: true });
  });
});

describe("applyWindowKeeperUpdate", () => {
  const current: WindowKeeperSettings = { claude: true, codex: true };

  it("checks the provider before the enabled flag", () => {
    expect(applyWindowKeeperUpdate(current, { provider: "nope", enabled: "nope" })).toEqual({
      ok: false,
      error: "invalid-provider",
    });
    expect(applyWindowKeeperUpdate(current, { provider: undefined, enabled: undefined })).toEqual({
      ok: false,
      error: "invalid-provider",
    });
  });

  it("rejects a non-boolean enabled for a valid provider", () => {
    for (const enabled of [undefined, null, "true", 1, 0]) {
      expect(applyWindowKeeperUpdate(current, { provider: "claude", enabled })).toEqual({
        ok: false,
        error: "invalid-enabled",
      });
    }
  });

  it("applies a valid update to one provider, keeping the other", () => {
    expect(applyWindowKeeperUpdate(current, { provider: "claude", enabled: false })).toEqual({
      ok: true,
      settings: { claude: false, codex: true },
    });
    expect(
      applyWindowKeeperUpdate(
        { claude: false, codex: true },
        {
          provider: "codex",
          enabled: false,
        },
      ),
    ).toEqual({
      ok: true,
      settings: { claude: false, codex: false },
    });
  });
});

describe("toWindowKeeperConfig", () => {
  it("renders both providers in KEEPER_PROFILES order with profile labels", () => {
    expect(toWindowKeeperConfig({ claude: false, codex: true })).toEqual({
      providers: [
        { id: "claude", label: "Claude", enabled: false },
        { id: "codex", label: "Codex", enabled: true },
      ],
    });
  });
});

describe("createWindowKeeperService", () => {
  it("returns the defaults on first read", async () => {
    const { storage } = fakeStorage();
    const service = createWindowKeeperService({ storage, onSettings: () => {} });
    expect(await service.getConfig()).toEqual(toWindowKeeperConfig(DEFAULT_WINDOW_KEEPER_SETTINGS));
  });

  it("validates, persists, then calls onSettings", async () => {
    const { storage, data } = fakeStorage();
    const calls: WindowKeeperSettings[] = [];
    const service = createWindowKeeperService({
      storage,
      onSettings: (settings) => calls.push(settings),
    });

    const result = await service.setEnabled({ provider: "claude", enabled: false });
    expect(result).toEqual({
      ok: true,
      config: toWindowKeeperConfig({ claude: false, codex: true }),
    });
    expect(data.get(WINDOW_KEEPER_SETTINGS_KEY)).toBe(
      JSON.stringify({ claude: false, codex: true }),
    );
    expect(calls).toEqual([{ claude: false, codex: true }]);
  });

  it("reflects a persisted update on the next getConfig", async () => {
    const { storage } = fakeStorage();
    const service = createWindowKeeperService({ storage, onSettings: () => {} });
    await service.setEnabled({ provider: "codex", enabled: false });
    expect(await service.getConfig()).toEqual(toWindowKeeperConfig({ claude: true, codex: false }));
  });

  it("does not persist or notify on a rejected update", async () => {
    const { storage, data } = fakeStorage();
    const calls: WindowKeeperSettings[] = [];
    const service = createWindowKeeperService({
      storage,
      onSettings: (settings) => calls.push(settings),
    });

    expect(await service.setEnabled({ provider: "nope", enabled: false })).toEqual({
      ok: false,
      error: "invalid-provider",
    });
    expect(await service.setEnabled({ provider: "claude", enabled: "yes" })).toEqual({
      ok: false,
      error: "invalid-enabled",
    });
    expect(data.has(WINDOW_KEEPER_SETTINGS_KEY)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reads storage on every getConfig (external writes are visible)", async () => {
    const { storage, data } = fakeStorage();
    const service = createWindowKeeperService({ storage, onSettings: () => {} });
    data.set(WINDOW_KEEPER_SETTINGS_KEY, JSON.stringify({ claude: false, codex: false }));
    expect(await service.getConfig()).toEqual(
      toWindowKeeperConfig({ claude: false, codex: false }),
    );
  });
});
