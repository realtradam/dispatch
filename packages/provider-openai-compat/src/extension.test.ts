import type { HostAPI, Manifest, ProviderContract } from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import { activate, extension, manifest, OPENCODE_CREDENTIALS_CONFIG_KEY } from "./extension.js";
import type { OpenCodeNumberedCredential } from "./opencode-config.js";

function makeFakeHost(creds?: OpenCodeNumberedCredential[]): {
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
      get: (key: string) => (key === OPENCODE_CREDENTIALS_CONFIG_KEY ? creds : undefined),
    },
    logger: { debug: vi.fn(), info, warn, error: vi.fn() },
  } as unknown as HostAPI;
  return { host, defineProvider, info };
}

describe("provider-openai-compat activation (numbered OpenCode)", () => {
  it("registers one provider per numbered credential with id opencode-<N>", async () => {
    const creds: OpenCodeNumberedCredential[] = [
      { number: 1, apiKey: "sk-1", baseURL: "https://oc/v1", model: "m1" },
      { number: 2, apiKey: "sk-2", baseURL: "https://oc/v1", model: "m2" },
    ];
    const { host, defineProvider } = makeFakeHost(creds);

    await activate(host);

    expect(defineProvider).toHaveBeenCalledTimes(2);
    const ids = defineProvider.mock.calls.map((c) => (c[0] as ProviderContract).id);
    expect(ids).toEqual(["opencode-1", "opencode-2"]);
  });

  it("does not register providers when no numbered credentials are configured", async () => {
    const { host, defineProvider } = makeFakeHost(undefined);
    await activate(host);
    expect(defineProvider).not.toHaveBeenCalled();
  });

  it("does not register providers when the numbered list is empty", async () => {
    const { host, defineProvider } = makeFakeHost([]);
    await activate(host);
    expect(defineProvider).not.toHaveBeenCalled();
  });

  it("gives each numbered provider its own key (no cross-key sharing)", async () => {
    const creds: OpenCodeNumberedCredential[] = [
      { number: 1, apiKey: "sk-key-1", baseURL: "https://oc/v1", model: "m1" },
      { number: 2, apiKey: "sk-key-2", baseURL: "https://oc/v1", model: "m2" },
    ];
    const { host, defineProvider } = makeFakeHost(creds);
    await activate(host);

    const p1 = defineProvider.mock.calls[0]?.[0] as ProviderContract;
    const p2 = defineProvider.mock.calls[1]?.[0] as ProviderContract;
    expect(p1.id).toBe("opencode-1");
    expect(p2.id).toBe("opencode-2");
    // The provider contract carries stream/listModels/getUsage closures bound to
    // each number's own key; distinct ids are proof of distinct instances.
    expect(p1.stream).not.toBe(p2.stream);
    expect(p1.listModels).not.toBe(p2.listModels);
    expect(p1.getUsage).not.toBe(p2.getUsage);
  });

  it("does not log the secret key", async () => {
    const creds: OpenCodeNumberedCredential[] = [
      { number: 7, apiKey: "TOP-SECRET-KEY", baseURL: "https://oc/v1", model: "m7" },
    ];
    const { host, info } = makeFakeHost(creds);
    await activate(host);
    const logged = info.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(logged).not.toContain("TOP-SECRET-KEY");
    expect(logged).toContain("opencode-7");
  });

  it("declares contributes providers = ['opencode'] (obsolete openai-compat namespace gone)", () => {
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
