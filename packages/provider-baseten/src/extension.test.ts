import type { HostAPI } from "@dispatch/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("provider-baseten activation", () => {
  it('activate registers the "baseten" provider when BASETEN_API_KEY is set (defineProvider called with id "baseten")', async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { BASETEN_API_KEY: "sk-test" };

    await activate(host, env);

    expect(defineProvider).toHaveBeenCalledTimes(1);
    expect(defineProvider.mock.calls[0]?.[0]?.id).toBe("baseten");
  });

  it("activate does NOT register + warns when BASETEN_API_KEY is unset", async () => {
    const { host, defineProvider, warn } = makeFakeHost({});
    const env: EnvSource = {};

    await activate(host, env);

    expect(defineProvider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "provider-baseten: no BASETEN_API_KEY. Provider not registered.",
    );
  });

  it("declares no dependsOn (self-contained, reads env directly)", () => {
    expect(manifest.dependsOn).toBeUndefined();
  });

  it("declares the baseten provider contribution + network capability", () => {
    expect(manifest.contributes?.providers).toEqual(["baseten"]);
    expect(manifest.capabilities?.network).toBe(true);
    expect(manifest.tier).toBe("providers");
  });

  describe("wire auth", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("sends `Authorization: Api-Key <key>` (not Bearer) to the Baseten endpoint", async () => {
      const calls: { url: string; auth: string | undefined }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          calls.push({
            url,
            auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
          });
          return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
        }),
      );
      const { host, defineProvider } = makeFakeHost({});
      await activate(host, { BASETEN_API_KEY: "test-key-123" });
      const provider = defineProvider.mock.calls[0]?.[0];
      await provider.listModels();
      expect(calls).toEqual([
        { url: "https://inference.baseten.co/v1/models", auth: "Api-Key test-key-123" },
      ]);
    });

    it("omits getUsage (Baseten has no /usage concurrent_sessions endpoint)", async () => {
      const { host, defineProvider } = makeFakeHost({});
      await activate(host, { BASETEN_API_KEY: "test-key-123" });
      expect(defineProvider.mock.calls[0]?.[0]?.getUsage).toBeUndefined();
    });
  });
});
