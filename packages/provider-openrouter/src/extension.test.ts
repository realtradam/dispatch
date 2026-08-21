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

describe("provider-openrouter activation", () => {
  it('activate registers exactly one "openrouter" provider when OPENROUTER_API_KEY is set', async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { OPENROUTER_API_KEY: "sk-or-v1-test" };

    await activate(host, env);

    expect(defineProvider).toHaveBeenCalledTimes(1);
    expect(defineProvider.mock.calls[0]?.[0]?.id).toBe("openrouter");
  });

  it("registered provider has listModels and does NOT have getUsage (opt-out honored)", async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { OPENROUTER_API_KEY: "sk-or-v1-test" };

    await activate(host, env);

    const provider = defineProvider.mock.calls[0]?.[0];
    expect(provider).toBeDefined();
    expect(provider?.listModels).toBeTypeOf("function");
    expect("getUsage" in provider).toBe(false);
  });

  it("activate does NOT register + warns when OPENROUTER_API_KEY is unset", async () => {
    const { host, defineProvider, warn } = makeFakeHost({});
    const env: EnvSource = {};

    await activate(host, env);

    expect(defineProvider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "provider-openrouter: no OPENROUTER_API_KEY. Provider not registered.",
    );
  });

  it("logs only provider/model state when registering (no key material)", async () => {
    const { host, info } = makeFakeHost({});
    const env: EnvSource = { OPENROUTER_API_KEY: "sk-super-secret-value" };

    await activate(host, env);

    expect(info).toHaveBeenCalledWith(
      "provider-openrouter: registered (model=openrouter/meta-llama/llama-3.1-8b-instruct:free)",
    );
    // The log must never contain the key.
    const logged = info.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).not.toContain("sk-super-secret-value");
  });

  it("declares no dependsOn (self-contained, reads env directly)", () => {
    expect(manifest.dependsOn).toBeUndefined();
  });

  it("declares the openrouter provider contribution + bundled trust + network capability", () => {
    expect(manifest.contributes?.providers).toEqual(["openrouter"]);
    expect(manifest.trust).toBe("bundled");
    expect(manifest.capabilities?.network).toBe(true);
    expect(manifest.activation).toBe("eager");
  });
});
