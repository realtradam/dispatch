import type { HostAPI } from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import { activate, manifest } from "./extension.js";
import type { EnvSource } from "./resolver.js";

function makeFakeHost(overrides: { configGet?: (key: string) => unknown }): {
  host: HostAPI;
  defineProvider: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  const defineProvider = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const host = {
    defineProvider,
    config: { get: overrides.configGet ?? (() => undefined) },
    logger: { debug: vi.fn(), info, warn, error: vi.fn() },
  } as unknown as HostAPI;
  return { host, defineProvider, warn, info };
}

describe("provider-systalyze activation", () => {
  it('activate registers exactly one "systalyze" provider when the key is set', async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { SYSTALYZE_API_KEY: "k" };

    await activate(host, env);

    expect(defineProvider).toHaveBeenCalledTimes(1);
    expect(defineProvider.mock.calls[0]?.[0]?.id).toBe("systalyze");
  });

  it("activates from the STLZ_API_KEY alias too", async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { STLZ_API_KEY: "k" };

    await activate(host, env);

    expect(defineProvider).toHaveBeenCalledTimes(1);
    expect(defineProvider.mock.calls[0]?.[0]?.id).toBe("systalyze");
  });

  it("registered provider has listModels and does NOT have getUsage (opt-out honored)", async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { SYSTALYZE_API_KEY: "k" };

    await activate(host, env);

    const provider = defineProvider.mock.calls[0]?.[0];
    expect(provider).toBeDefined();
    expect(provider?.listModels).toBeTypeOf("function");
    expect(provider?.stream).toBeTypeOf("function");
    // Systalyze's /v1/usage route 404s — the contract must omit getUsage.
    expect("getUsage" in provider).toBe(false);
  });

  it("activate does NOT register + warns when no key is set", async () => {
    const { host, defineProvider, warn } = makeFakeHost({});
    const env: EnvSource = {};

    await activate(host, env);

    expect(defineProvider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "provider-systalyze: no SYSTALYZE_API_KEY. Provider not registered.",
    );
  });

  it("uses provider.systalyze.model from host config", async () => {
    const { host, info } = makeFakeHost({
      configGet: (key) => (key === "provider.systalyze.model" ? "config-model" : undefined),
    });

    await activate(host, { SYSTALYZE_API_KEY: "k" });

    expect(info).toHaveBeenCalledWith("provider-systalyze: registered (model=config-model)");
  });

  it("logs only provider/model state when registering (no key material)", async () => {
    const { host, info } = makeFakeHost({});
    const env: EnvSource = { SYSTALYZE_API_KEY: "stlzi_super_secret_value" };

    await activate(host, env);

    expect(info).toHaveBeenCalledWith("provider-systalyze: registered (model=moonshotai/Kimi-K3)");
    const logged = info.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).not.toContain("stlzi_super_secret_value");
  });

  it("declares no dependsOn (self-contained, reads env directly)", () => {
    expect(manifest.dependsOn).toBeUndefined();
  });

  it("declares the systalyze provider contribution + bundled trust + network capability", () => {
    expect(manifest.contributes?.providers).toEqual(["systalyze"]);
    expect(manifest.trust).toBe("bundled");
    expect(manifest.capabilities?.network).toBe(true);
    expect(manifest.activation).toBe("eager");
    expect(manifest.tier).toBe("providers");
  });
});
