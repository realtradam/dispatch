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

describe("provider-longcat activation", () => {
  it('activate registers the "longcat" provider when LONGCAT_API_KEY is set (defineProvider called with id "longcat")', async () => {
    const { host, defineProvider } = makeFakeHost({});
    const env: EnvSource = { LONGCAT_API_KEY: "sk-test" };

    await activate(host, env);

    expect(defineProvider).toHaveBeenCalledTimes(1);
    expect(defineProvider.mock.calls[0]?.[0]?.id).toBe("longcat");
  });

  it("activate does NOT register + warns when LONGCAT_API_KEY is unset", async () => {
    const { host, defineProvider, warn } = makeFakeHost({});
    const env: EnvSource = {};

    await activate(host, env);

    expect(defineProvider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "provider-longcat: no LONGCAT_API_KEY. Provider not registered.",
    );
  });

  it("declares no dependsOn (self-contained, reads env directly)", () => {
    expect(manifest.dependsOn).toBeUndefined();
  });

  it("declares the longcat provider contribution + network capability", () => {
    expect(manifest.contributes?.providers).toEqual(["longcat"]);
    expect(manifest.capabilities?.network).toBe(true);
  });
});
