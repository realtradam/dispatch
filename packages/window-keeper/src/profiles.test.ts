import { describe, expect, it } from "vitest";
import { CLAUDE_PROFILE, CODEX_PROFILE, KEEPER_PROFILES, type KeeperProfile } from "./profiles.js";

const SERVER_NOW = 1_760_000_000_000;

const headers = (entries: Record<string, string>): Readonly<Record<string, string>> => entries;

describe("KEEPER_PROFILES", () => {
  it("is in the fixed order claude, codex", () => {
    expect(KEEPER_PROFILES.map((profile) => profile.id)).toEqual(["claude", "codex"]);
    expect(KEEPER_PROFILES[0]).toBe(CLAUDE_PROFILE);
    expect(KEEPER_PROFILES[1]).toBe(CODEX_PROFILE);
  });
});

describe("CLAUDE_PROFILE", () => {
  it("has the documented table values", () => {
    const profile: KeeperProfile = CLAUDE_PROFILE;
    expect(profile.id).toBe("claude");
    expect(profile.label).toBe("Claude");
    expect(profile.providerId).toBe("anthropic");
    expect(profile.authId).toBe("claude-oauth");
    expect(profile.limitId).toBe("claude:5h");
    expect(profile.streamOptions).toEqual({});
  });

  describe("parseReset", () => {
    const parse = CLAUDE_PROFILE.parseReset;

    it("reads the unified 5h reset (Unix seconds) as epoch ms", () => {
      expect(
        parse(headers({ "anthropic-ratelimit-unified-5h-reset": "1760003600" }), SERVER_NOW),
      ).toBe(1_760_003_600_000);
    });

    it("returns null when absent, empty, non-numeric, zero or negative", () => {
      expect(parse(headers({}), SERVER_NOW)).toBeNull();
      expect(parse(headers({ "anthropic-ratelimit-unified-5h-reset": "" }), SERVER_NOW)).toBeNull();
      expect(
        parse(headers({ "anthropic-ratelimit-unified-5h-reset": "abc" }), SERVER_NOW),
      ).toBeNull();
      expect(
        parse(headers({ "anthropic-ratelimit-unified-5h-reset": "0" }), SERVER_NOW),
      ).toBeNull();
      expect(
        parse(headers({ "anthropic-ratelimit-unified-5h-reset": "-5" }), SERVER_NOW),
      ).toBeNull();
    });

    it("ignores serverNow", () => {
      const h = headers({ "anthropic-ratelimit-unified-5h-reset": "1760003600" });
      expect(parse(h, 0)).toBe(parse(h, 10_000_000));
    });
  });

  describe("pickModel", () => {
    const pick = CLAUDE_PROFILE.pickModel;

    it("picks the first id containing haiku", () => {
      expect(pick([])).toBeUndefined();
      expect(pick(["claude-sonnet-4"])).toBeUndefined();
      expect(pick(["claude-sonnet-4", "claude-haiku-4-5", "other-haiku"])).toBe("claude-haiku-4-5");
    });
  });
});

describe("CODEX_PROFILE", () => {
  it("has the documented table values", () => {
    const profile: KeeperProfile = CODEX_PROFILE;
    expect(profile.id).toBe("codex");
    expect(profile.label).toBe("Codex");
    expect(profile.providerId).toBe("openai");
    expect(profile.authId).toBe("codex-oauth");
    expect(profile.limitId).toBe("codex:primary");
    expect(profile.streamOptions).toEqual({
      reasoningEffort: "low",
      systemPrompt: "Reply with the single word OK.",
    });
  });

  describe("pickModel", () => {
    it("always returns undefined (the provider default)", () => {
      expect(CODEX_PROFILE.pickModel([])).toBeUndefined();
      expect(CODEX_PROFILE.pickModel(["gpt-5-codex", "gpt-5"])).toBeUndefined();
    });
  });

  describe("parseReset", () => {
    const parse = CODEX_PROFILE.parseReset;

    it("returns null first when the window-minutes header says there is no window", () => {
      expect(parse(headers({ "x-codex-primary-window-minutes": "0" }), SERVER_NOW)).toBeNull();
      expect(parse(headers({ "x-codex-primary-window-minutes": "-5" }), SERVER_NOW)).toBeNull();
      // Ordered before the other headers.
      expect(
        parse(
          headers({
            "x-codex-primary-window-minutes": "0",
            "x-codex-primary-reset-at": "1760003600",
            "x-codex-primary-reset-after-seconds": "600",
          }),
          SERVER_NOW,
        ),
      ).toBeNull();
    });

    it("does not treat a non-numeric window-minutes header as 'no window'", () => {
      expect(
        parse(
          headers({
            "x-codex-primary-window-minutes": "abc",
            "x-codex-primary-reset-after-seconds": "600",
          }),
          SERVER_NOW,
        ),
      ).toBe(SERVER_NOW + 600_000);
    });

    it("reads x-codex-primary-reset-at as seconds below 1e12 and as ms at or above it", () => {
      expect(parse(headers({ "x-codex-primary-reset-at": "1760003600" }), SERVER_NOW)).toBe(
        1_760_003_600_000,
      );
      expect(parse(headers({ "x-codex-primary-reset-at": "999999999999" }), SERVER_NOW)).toBe(
        999_999_999_999_000,
      );
      expect(parse(headers({ "x-codex-primary-reset-at": "1760003600000" }), SERVER_NOW)).toBe(
        1_760_003_600_000,
      );
      expect(parse(headers({ "x-codex-primary-reset-at": "1000000000000" }), SERVER_NOW)).toBe(
        1_000_000_000_000,
      );
    });

    it("ignores a non-positive / non-numeric reset-at and falls through", () => {
      expect(
        parse(
          headers({
            "x-codex-primary-reset-at": "0",
            "x-codex-primary-reset-after-seconds": "60",
          }),
          SERVER_NOW,
        ),
      ).toBe(SERVER_NOW + 60_000);
      expect(parse(headers({ "x-codex-primary-reset-at": "-5" }), SERVER_NOW)).toBeNull();
      expect(parse(headers({ "x-codex-primary-reset-at": "abc" }), SERVER_NOW)).toBeNull();
    });

    it("reads x-codex-primary-reset-after-seconds as serverNow + seconds", () => {
      expect(parse(headers({ "x-codex-primary-reset-after-seconds": "600" }), SERVER_NOW)).toBe(
        SERVER_NOW + 600_000,
      );
      expect(parse(headers({ "x-codex-primary-reset-after-seconds": "0" }), SERVER_NOW)).toBe(
        SERVER_NOW,
      );
    });

    it("rejects a negative or non-numeric reset-after and returns null", () => {
      expect(
        parse(headers({ "x-codex-primary-reset-after-seconds": "-1" }), SERVER_NOW),
      ).toBeNull();
      expect(
        parse(headers({ "x-codex-primary-reset-after-seconds": "abc" }), SERVER_NOW),
      ).toBeNull();
    });

    it("returns null when no reset header is present", () => {
      expect(parse(headers({}), SERVER_NOW)).toBeNull();
    });
  });
});
