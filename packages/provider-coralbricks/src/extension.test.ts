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

describe("provider-coralbricks activation", () => {
  it('activate registers exactly one "coralbricks" provider when CORAL_API_KEY is set', async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { CORAL_API_KEY: "cb-test" };

    await activate(host, env);

    expect(defineProvider).toHaveBeenCalledTimes(1);
    expect(defineProvider.mock.calls[0]?.[0]?.id).toBe("coralbricks");
  });

  it("registered provider has listModels and does NOT have getUsage (opt-out honored)", async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { CORAL_API_KEY: "cb-test" };

    await activate(host, env);

    const provider = defineProvider.mock.calls[0]?.[0];
    expect(provider).toBeDefined();
    expect(provider?.listModels).toBeTypeOf("function");
    expect("getUsage" in provider).toBe(false);
  });

  it("activate does NOT register + warns when CORAL_API_KEY is unset", async () => {
    const { host, defineProvider, warn } = makeFakeHost({});
    const env: EnvSource = {};

    await activate(host, env);

    expect(defineProvider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "provider-coralbricks: no CORAL_API_KEY. Provider not registered.",
    );
  });

  it("uses the host-configured model when present", async () => {
    const { host, info } = makeFakeHost({
      configGet: (key) => (key === "provider.coralbricks.model" ? "glm-5.3-fast" : undefined),
    });
    const env: EnvSource = { CORAL_API_KEY: "cb-test" };

    await activate(host, env);

    expect(info).toHaveBeenCalledWith("provider-coralbricks: registered (model=glm-5.3-fast)");
  });

  it("logs only provider/model state when registering (no key material)", async () => {
    const { host, info } = makeFakeHost({});
    const env: EnvSource = { CORAL_API_KEY: "cb-super-secret-value" };

    await activate(host, env);

    expect(info).toHaveBeenCalledWith(
      "provider-coralbricks: registered (model=deepseek-v4.1-flash-fast)",
    );
    const logged = info.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).not.toContain("cb-super-secret-value");
  });

  it("declares no dependsOn (self-contained, reads env directly)", () => {
    expect(manifest.dependsOn).toBeUndefined();
  });

  it("declares the coralbricks provider contribution + bundled trust + network capability", () => {
    expect(manifest.contributes?.providers).toEqual(["coralbricks"]);
    expect(manifest.trust).toBe("bundled");
    expect(manifest.capabilities?.network).toBe(true);
    expect(manifest.activation).toBe("eager");
    expect(manifest.tier).toBe("providers");
  });
});
