import type { ApiKeyCredentials, AuthContract, HostAPI } from "@dispatch/kernel";
import { describe, expect, it, vi } from "vitest";
import { activate, manifest } from "./extension.js";

function makeFakeHost(overrides: {
  getAuthProvider?: (id: string) => AuthContract | undefined;
  configGet?: (key: string) => unknown;
}): { host: HostAPI; defineProvider: ReturnType<typeof vi.fn> } {
  const defineProvider = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const host = {
    defineProvider,
    config: { get: overrides.configGet ?? (() => undefined) },
    logger: { debug: vi.fn(), info, warn, error: vi.fn() },
    getAuthProvider: overrides.getAuthProvider ?? (() => undefined),
  } as unknown as HostAPI;
  return { host, defineProvider };
}

describe("provider-openai-compat activation", () => {
  it("registers provider when auth resolves ApiKeyCredentials", async () => {
    const fakeCreds: ApiKeyCredentials = { type: "api-key", apiKey: "sk-test" };
    const fakeAuth: AuthContract = {
      id: "apikey",
      resolve: async () => fakeCreds,
    };

    const { host, defineProvider } = makeFakeHost({
      getAuthProvider: (id) => (id === "apikey" ? fakeAuth : undefined),
    });

    await activate(host);

    expect(defineProvider).toHaveBeenCalledTimes(1);
    expect(defineProvider.mock.calls[0]?.[0]?.id).toBe("openai-compat");
  });

  it("does not register provider when getAuthProvider returns undefined", async () => {
    const { host, defineProvider } = makeFakeHost({
      getAuthProvider: () => undefined,
    });

    await activate(host);

    expect(defineProvider).not.toHaveBeenCalled();
  });

  it("does not register provider when resolve returns null", async () => {
    const fakeAuth: AuthContract = {
      id: "apikey",
      resolve: async () => null,
    };

    const { host, defineProvider } = makeFakeHost({
      getAuthProvider: (id) => (id === "apikey" ? fakeAuth : undefined),
    });

    await activate(host);

    expect(defineProvider).not.toHaveBeenCalled();
  });

  it("does not register provider when credentials are not api-key type", async () => {
    const fakeAuth: AuthContract = {
      id: "apikey",
      resolve: async () => ({ type: "bearer-token", token: "tok-123" }),
    };

    const { host, defineProvider } = makeFakeHost({
      getAuthProvider: (id) => (id === "apikey" ? fakeAuth : undefined),
    });

    await activate(host);

    expect(defineProvider).not.toHaveBeenCalled();
  });

  it("uses default model when config returns undefined", async () => {
    const fakeCreds: ApiKeyCredentials = { type: "api-key", apiKey: "sk-test" };
    const fakeAuth: AuthContract = {
      id: "apikey",
      resolve: async () => fakeCreds,
    };

    const { host, defineProvider } = makeFakeHost({
      getAuthProvider: (id) => (id === "apikey" ? fakeAuth : undefined),
      configGet: () => undefined,
    });

    await activate(host);

    expect(defineProvider).toHaveBeenCalledTimes(1);
  });

  it("declares dependsOn auth-apikey", () => {
    expect(manifest.dependsOn).toEqual(["auth-apikey"]);
  });
});
