import type { HostAPI, Manifest, ProviderContract } from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import { activate, extension, manifest, OPENCODE_CREDENTIAL_CONFIG_KEY } from "./extension.js";
import type { OpenCodeCredential } from "./opencode-config.js";

function makeFakeHost(cred?: OpenCodeCredential): {
  host: HostAPI;
  defineProvider: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  const defineProvider = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const host = {
    defineProvider,
    config: {
      get: (key: string) => (key === OPENCODE_CREDENTIAL_CONFIG_KEY ? cred : undefined),
    },
    logger: { debug: vi.fn(), info, warn, error: vi.fn() },
  } as unknown as HostAPI;
  return { host, defineProvider, info };
}

describe("provider-openai-compat activation (OpenCode)", () => {
  it("registers ONE provider with the unnumbered id `opencode`", async () => {
    const { host, defineProvider } = makeFakeHost({
      apiKey: "sk-1",
      baseURL: "https://oc/v1",
      model: "m1",
    });

    await activate(host);

    expect(defineProvider).toHaveBeenCalledTimes(1);
    const provider = defineProvider.mock.calls[0]?.[0] as ProviderContract;
    expect(provider.id).toBe("opencode");
    expect(typeof provider.stream).toBe("function");
    expect(typeof provider.listModels).toBe("function");
  });

  it("does not register a provider when no credential is configured", async () => {
    const { host, defineProvider } = makeFakeHost(undefined);
    await activate(host);
    expect(defineProvider).not.toHaveBeenCalled();
  });

  it("does not log the secret key", async () => {
    const { host, info } = makeFakeHost({
      apiKey: "TOP-SECRET-KEY",
      baseURL: "https://oc/v1",
      model: "m7",
    });
    await activate(host);
    const logged = info.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(logged).not.toContain("TOP-SECRET-KEY");
    expect(logged).toContain('\\"opencode\\"');
    expect(logged).toContain("m7");
  });

  it("declares contributes providers = ['opencode']", () => {
    expect(manifest.contributes?.providers).toEqual(["opencode"]);
    expect(manifest.tier).toBe("providers");
  });

  it("no longer depends on auth-apikey", () => {
    expect(manifest.dependsOn).toBeUndefined();
  });

  it("exports the extension object", () => {
    expect(extension).toBeDefined();
    expect((extension.manifest as Manifest).id).toBe("provider-openai-compat");
  });
});
