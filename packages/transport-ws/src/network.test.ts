import { createBus, type HostAPI, type Logger, runTurn } from "@dispatch/kernel";
import {
  buildAllowedHosts,
  type NetworkPolicyConfig,
  type NetworkPolicySnapshot,
} from "@dispatch/network-policy";
import {
  createSessionOrchestrator,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import { createSurfaceRegistry, surfaceRegistryHandle } from "@dispatch/surface-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationStore } from "../../conversation-store/src/index.js";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createTransportWsExtension, guardUpgrade, startListeners } from "./extension.js";

describe("WS upgrade guard", () => {
  it.each([
    ["evil.com", undefined, 421],
    ["localhost", "https://evil.com", 403],
    ["localhost", "null", 403],
    ["localhost", "http://PII_REDACTED_DEVICE_01:24204", undefined],
    ["localhost", undefined, undefined],
  ] as const)("guards %s / %s", (host, origin, status) => {
    const headers = new Headers({ Host: host });
    if (origin !== undefined) headers.set("Origin", origin);
    expect(
      guardUpgrade(
        new Request("http://localhost/", { headers }),
        new Set(["localhost", "PII_REDACTED_DEVICE_01"]),
      )?.status,
    ).toBe(status);
  });
});

describe("WS listener lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  it("warns, retries Tailscale after 10s, and clears retries on stop", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const stop = vi.fn();
    let attempts = 0;
    const listeners = startListeners(
      ["PII_REDACTED_DEV_IPV4_01"],
      ["PII_REDACTED_DEV_IPV4_01"],
      () => {
        if (++attempts === 1) throw new Error("not assigned");
        return { stop };
      },
      { warn },
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(attempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    listeners.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("cancels a still-failing retry on deactivate", () => {
    vi.useFakeTimers();
    const bind = vi.fn(() => {
      throw new Error("unavailable");
    });
    const listeners = startListeners(["PII_REDACTED_DEV_IPV4_01"], ["PII_REDACTED_DEV_IPV4_01"], bind, {
      warn: vi.fn(),
    });
    listeners.stop();
    vi.advanceTimersByTime(20_000);
    expect(bind).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rolls back earlier listeners on fatal loopback failure", () => {
    const stop = vi.fn();
    expect(() =>
      startListeners(
        ["127.0.0.1", "::1"],
        [],
        (address) => {
          if (address === "::1") throw new Error("occupied");
          return { stop };
        },
        { warn: vi.fn() },
      ),
    ).toThrow("occupied");
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("dynamic listener reconciliation", () => {
  it("adds once, removes stale servers/retries, and ignores late retry callbacks after stop", () => {
    const scheduled = new Set<() => void>();
    const callbacks: Array<() => void> = [];
    const bind = vi.fn((address: string) => {
      if (address === "100.64.0.2") throw new Error("not assigned");
      return { stop: vi.fn() };
    });
    const listeners = startListeners(
      ["127.0.0.1"],
      [],
      bind,
      { warn: vi.fn() },
      (callback, delay) => {
        expect(delay).toBe(10_000);
        scheduled.add(callback);
        callbacks.push(callback);
        return () => {
          scheduled.delete(callback);
        };
      },
    );
    const loopback = listeners.servers[0];
    const next = {
      bindAddresses: ["127.0.0.1", "100.64.0.1", "100.64.0.2"],
      tailscaleIps: ["100.64.0.1", "100.64.0.2"],
    };
    listeners.update(next);
    const tailnet = listeners.servers[1];
    listeners.update(next);
    expect(bind).toHaveBeenCalledTimes(3);
    expect(scheduled.size).toBe(1);
    listeners.update({ bindAddresses: ["127.0.0.1", "100.64.0.3"], tailscaleIps: ["100.64.0.3"] });
    expect(tailnet?.stop).toHaveBeenCalledWith(true);
    expect(loopback?.stop).not.toHaveBeenCalled();
    expect(scheduled.size).toBe(0);
    for (const callback of callbacks) callback();
    expect(bind).toHaveBeenCalledTimes(4);
    // Removing and re-adding an unavailable IP must not revive its OLD retry.
    listeners.update(next);
    expect(bind).toHaveBeenCalledTimes(6);
    expect(scheduled.size).toBe(1);
    callbacks[0]?.();
    expect(bind).toHaveBeenCalledTimes(6);
    listeners.stop();
    listeners.stop();
    listeners.update(next);
    for (const callback of callbacks) callback();
    expect(bind).toHaveBeenCalledTimes(6);
    expect(scheduled.size).toBe(0);
    expect(loopback?.stop).toHaveBeenCalledOnce();
    expect(listeners.servers).toEqual([]);
  });

  it("starts pending with zero addresses, then binds IPv4 and IPv6", () => {
    const bind = vi.fn(() => ({ stop: vi.fn() }));
    const listeners = startListeners([], [], bind, { warn: vi.fn() });
    expect(bind).not.toHaveBeenCalled();
    listeners.update({
      bindAddresses: ["100.64.0.1", "fd7a:115c:a1e0::1"],
      tailscaleIps: ["100.64.0.1", "fd7a:115c:a1e0::1"],
    });
    expect(bind.mock.calls).toHaveLength(2);
    expect(listeners.servers).toHaveLength(2);
    listeners.stop();
  });
});

// Real extension/app/guard, fake only the host composition and Bun listener edge.
it("refreshes listeners and Host/Origin guards together and unsubscribes on unload", async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
  const bus = createBus(logger);

  const deps = {
    conversationStore: createConversationStore(storageFromMap()),
    resolveProvider: () => {
      throw new Error("no network provider in network-policy test");
    },
    resolveTools: () => [],
    runTurn,
    applyToolsFilter: async (assembly: import("@dispatch/session-orchestrator").ToolAssembly) =>
      assembly,
    emit: bus.emit,
  };
  const bundle = createSessionOrchestrator(deps);
  bus.provideService(sessionOrchestratorHandle, bundle.orchestrator);
  bus.provideService(surfaceRegistryHandle, createSurfaceRegistry());

  let snapshot: NetworkPolicySnapshot = {
    allowedHosts: buildAllowedHosts({ env: {} }),
    bindAddresses: ["127.0.0.1"],
    tailscaleIps: [],
  };
  const subscribers = new Set<(snapshot: NetworkPolicySnapshot) => void>();
  const policy: NetworkPolicyConfig = {
    ...snapshot,
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  };
  const options: Array<Bun.ServeOptions<unknown>> = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  vi.stubGlobal("Bun", {
    serve: (opts: Bun.ServeOptions<unknown>) => {
      options.push(opts);
      const stop = vi.fn();
      stops.push(stop);
      return { stop };
    },
  });
  const extension = createTransportWsExtension();
  try {
    await extension.activate({
      logger,
      getService: bus.getService,
      tryGetService: bus.tryGetService,
      on: bus.on,
      onServiceAvailable: bus.onServiceAvailable,
      onServiceUnavailable: bus.onServiceUnavailable,
      getExtensions: () => [],
      config: { get: (key: string) => (key === "networkPolicy" ? policy : 34205) },
    } as unknown as HostAPI);
    const fetch = options[0]?.fetch;
    if (!fetch) throw new Error("missing fetch");
    const request = async (host: string, origin?: string) => {
      const headers = new Headers({ Host: host });
      if (origin !== undefined) headers.set("Origin", origin);
      const response = await fetch.call(
        {} as never,
        new Request("http://localhost/health", { headers }),
        {} as never,
      );
      if (!response) throw new Error("missing response");
      return response;
    };
    expect((await request("100.64.0.1")).status).toBe(421);
    expect((await request("localhost", "http://phone.tailnet.ts.net")).status).toBe(403);
    snapshot = {
      allowedHosts: buildAllowedHosts({
        env: {},
        tailscaleStatusJson: JSON.stringify({
          Self: {
            DNSName: "phone.tailnet.ts.net.",
            TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
          },
        }),
      }),
      bindAddresses: ["127.0.0.1", "100.64.0.1", "fd7a:115c:a1e0::1"],
      tailscaleIps: ["100.64.0.1", "fd7a:115c:a1e0::1"],
    };
    for (const subscriber of subscribers) subscriber(snapshot);
    expect(options.map((option) => option.hostname)).toEqual(snapshot.bindAddresses);
    for (const host of ["100.64.0.1", "[fd7a:115c:a1e0::1]", "phone", "phone.tailnet.ts.net"]) {
      const response = await request(host, `http://${host}:34204`);
      expect(response.status).toBe(200);
    }
    expect((await request("evil.com")).status).toBe(421);
    expect((await request("localhost", "https://phone.tailnet.ts.net.evil.com")).status).toBe(403);
    for (const subscriber of subscribers)
      subscriber({
        allowedHosts: buildAllowedHosts({ env: {} }),
        bindAddresses: ["127.0.0.1"],
        tailscaleIps: [],
      });
    expect(stops[0]).not.toHaveBeenCalled();
    expect(stops[1]).toHaveBeenCalledWith(true);
    expect(stops[2]).toHaveBeenCalledWith(true);
    expect((await request("100.64.0.1")).status).toBe(421);
    expect((await request("localhost", "http://phone.tailnet.ts.net")).status).toBe(403);
    await extension.deactivate?.();
    expect(subscribers.size).toBe(0);
    expect(stops[0]).toHaveBeenCalledWith(true);
  } finally {
    await extension.deactivate?.();
    vi.unstubAllGlobals();
  }
});
