import { checkHost, checkOrigin } from "@dispatch/network-policy";
import { describe, expect, it, vi } from "vitest";
import { createNetworkPolicyMonitor, detectNetworkPolicy } from "./network.js";

describe("boot network edge", () => {
  it("detects once, verifies OS hostname, and resolves bind names", async () => {
    const status = vi.fn(async () =>
      JSON.stringify({
        Self: {
          DNSName: "workstation.example.",
          HostName: "laptop",
          TailscaleIPs: ["192.0.2.10"],
        },
      }),
    );
    const policy = await detectNetworkPolicy(
      { DISPATCH_BIND: "loopback,tailscale,extra" },
      { warn: vi.fn() },
      {
        status,
        resolve: async () => ["192.0.2.10"],
      },
    );
    expect(status).toHaveBeenCalledTimes(1);
    expect(policy.allowedHosts.has("workstation")).toBe(true);
    expect(policy.allowedHosts.has("laptop")).toBe(true);
    expect(policy.bindAddresses).toEqual(["127.0.0.1", "::1", "192.0.2.10"]);
  });
  it("fails closed on missing Tailscale and warns without falling back to wildcard", async () => {
    const warn = vi.fn();
    const policy = await detectNetworkPolicy(
      {},
      { warn },
      {
        status: async () => {
          throw new Error("timeout");
        },
        resolve: async () => [],
      },
    );
    expect(policy.bindAddresses).toEqual(["127.0.0.1", "::1"]);
    expect([...policy.allowedHosts]).toEqual(["localhost", "127.0.0.1", "::1"]);
    expect(warn).toHaveBeenCalled();
  });
  it("does not trust an OS hostname resolving outside Tailscale", async () => {
    const policy = await detectNetworkPolicy(
      {},
      { warn: vi.fn() },
      {
        status: async () =>
          JSON.stringify({ Self: { HostName: "laptop", TailscaleIPs: ["192.0.2.10"] } }),
        resolve: async () => ["192.168.1.2"],
      },
    );
    expect(policy.allowedHosts.has("laptop")).toBe(false);
  });
});

describe("live network policy", () => {
  const statusFor = (ips: string[], name = "workstation") =>
    JSON.stringify({
      Self: { TailscaleIPs: ips, DNSName: `${name}.tailnet.example.`, HostName: "verified-os" },
    });
  function clock() {
    let callback: (() => void) | undefined;
    const schedule = vi.fn((fn: () => void, delay: number) => {
      expect(callback).toBeUndefined();
      expect(delay).toBe(10_000);
      callback = fn;
      return () => {
        callback = undefined;
      };
    });
    return {
      schedule,
      pending: () => callback !== undefined,
      async tick() {
        const fn = callback;
        expect(fn).toBeDefined();
        callback = undefined;
        fn?.();
        // Only injected effects/microtasks, no wall-clock sleeps.
        for (let i = 0; i < 30; i++) await Promise.resolve();
      },
    };
  }

  it.each([
    "empty",
    "timeout",
    "malformed",
  ])("recovers from %s at boot and revokes changed/vanished IPs and names", async (boot) => {
    const timer = clock();
    let raw = boot === "empty" ? "{}" : "malformed";
    let fail = boot === "timeout";
    const status = vi.fn(async () => {
      if (fail) throw new Error("timeout");
      return raw;
    });
    const env = { DISPATCH_BIND: "loopback,tailscale", DISPATCH_ALLOWED_HOSTS: "explicit" };
    const monitor = await createNetworkPolicyMonitor(
      env,
      { warn: vi.fn() },
      {
        status,
        resolve: async () => ["100.64.0.1"],
        schedule: timer.schedule,
      },
    );
    const { policy } = monitor;
    expect(policy.bindAddresses).toEqual(["127.0.0.1", "::1"]);
    const changed = vi.fn();
    const unsubscribe = policy.subscribe?.(changed);
    env.DISPATCH_ALLOWED_HOSTS = "evil.com"; // boot config is copied
    fail = false;
    raw = statusFor(["100.64.0.1", "fd7a:115c:a1e0::1"]);
    await timer.tick();
    expect(status).toHaveBeenCalledTimes(2);
    expect(policy.bindAddresses).toEqual(["127.0.0.1", "::1", "100.64.0.1", "fd7a:115c:a1e0::1"]);
    for (const host of [
      "100.64.0.1:34203",
      "[fd7a:115c:a1e0::1]:34205",
      "workstation",
      "workstation.tailnet.example",
      "verified-os",
      "explicit",
    ]) {
      expect(checkHost(host, policy.allowedHosts)).toBe("ok");
      expect(checkOrigin(`https://${host}`, policy.allowedHosts)).toBe("ok");
    }
    expect(checkHost("evil.com", policy.allowedHosts)).toMatchObject({ status: 421 });
    expect(changed).toHaveBeenCalledOnce();
    raw = statusFor(["fd7a:115c:a1e0::1", "100.64.0.1"]);
    await timer.tick();
    expect(changed).toHaveBeenCalledOnce(); // no ordering-noise updates
    raw = statusFor(["100.64.0.2"], "new-name");
    await timer.tick();
    expect(policy.bindAddresses).toEqual(["127.0.0.1", "::1", "100.64.0.2"]);
    for (const host of [
      "100.64.0.1",
      "[fd7a:115c:a1e0::1]",
      "workstation.tailnet.example",
      "verified-os",
    ])
      expect(checkHost(host, policy.allowedHosts)).toMatchObject({ status: 421 });
    expect(checkHost("new-name.tailnet.example", policy.allowedHosts)).toBe("ok");
    fail = true;
    await timer.tick();
    expect(policy.bindAddresses).toEqual(["127.0.0.1", "::1", "100.64.0.2"]);
    expect(checkHost("100.64.0.2", policy.allowedHosts)).toBe("ok");
    expect(checkOrigin("http://new-name.tailnet.example", policy.allowedHosts)).toBe("ok");
    fail = false;
    raw = JSON.stringify({ Self: { TailscaleIPs: [] } });
    await timer.tick();
    expect(policy.bindAddresses).toEqual(["127.0.0.1", "::1"]);
    expect(checkHost("100.64.0.2", policy.allowedHosts)).toMatchObject({ status: 421 });
    expect(checkHost("explicit", policy.allowedHosts)).toBe("ok");
    unsubscribe?.();
    changed.mockClear();
    fail = false;
    await timer.tick();
    expect(changed).not.toHaveBeenCalled();
    monitor.stop();
    monitor.stop();
    expect(timer.pending()).toBe(false);
  });

  it.each([
    "timeout",
    "unavailable",
    "malformed",
    "incomplete",
    "invalid-ips",
    "invalid-name",
    "invalid-state",
    "dns",
  ])("retains the last-known-good snapshot on %s, deduplicates failures and recovers", async (failure) => {
    const timer = clock();
    let broken = false;
    let ip = "100.64.0.1";
    const warn = vi.fn();
    const monitor = await createNetworkPolicyMonitor(
      {},
      { warn },
      {
        status: async () => {
          if (broken) {
            if (failure === "timeout" || failure === "unavailable") throw new Error(failure);
            if (failure === "malformed") return "not json";
            if (failure === "incomplete")
              return JSON.stringify({ BackendState: "Running", Self: {} });
            if (failure === "invalid-ips")
              return JSON.stringify({ Self: { TailscaleIPs: ["bad"] } });
            if (failure === "invalid-state") return JSON.stringify({ BackendState: ["Stopped"] });
            if (failure === "invalid-name")
              return JSON.stringify({ Self: { TailscaleIPs: [], DNSName: 12 } });
          }
          return statusFor([ip]);
        },
        resolve: async () => {
          if (broken && failure === "dns") throw new Error("DNS failed");
          return [ip];
        },
        schedule: timer.schedule,
      },
    );
    const initial = monitor.policy.allowedHosts;
    const changed = vi.fn();
    monitor.policy.subscribe?.(changed);
    broken = true;
    for (let i = 0; i < 30; i++) await timer.tick();
    expect(monitor.policy.allowedHosts).toBe(initial);
    expect(monitor.policy.bindAddresses).toEqual(["127.0.0.1", "::1", ip]);
    expect(changed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("retaining last-known-good"));
    broken = false;
    await timer.tick(); // even unchanged successful status resets the warning streak
    expect(changed).not.toHaveBeenCalled();
    broken = true;
    await timer.tick();
    expect(warn).toHaveBeenCalledTimes(2);
    broken = false;
    ip = "100.64.0.2";
    await timer.tick();
    expect(changed).toHaveBeenCalledOnce();
    expect(monitor.policy.bindAddresses).toEqual(["127.0.0.1", "::1", ip]);
    expect(checkHost("100.64.0.1", monitor.policy.allowedHosts)).toMatchObject({ status: 421 });
    monitor.stop();
  });

  it.each([
    { Self: { TailscaleIPs: [] } },
    { Self: { TailscaleIPs: null } },
    { BackendState: "NeedsLogin", Self: null },
    { BackendState: "Stopped" },
    { BackendState: "NeedsMachineAuth" },
  ])("withdraws discovery on a validated positive no-IP status %j", async (empty) => {
    const timer = clock();
    let raw = statusFor(["100.64.0.1"]);
    const monitor = await createNetworkPolicyMonitor(
      { DISPATCH_TAILSCALE_NAME: "explicit-name" },
      { warn: vi.fn() },
      {
        status: async () => raw,
        resolve: async () => ["100.64.0.1"],
        schedule: timer.schedule,
      },
    );
    raw = JSON.stringify(empty);
    await timer.tick();
    expect(monitor.policy.bindAddresses).toEqual(["127.0.0.1", "::1"]);
    expect(checkHost("100.64.0.1", monitor.policy.allowedHosts)).toMatchObject({ status: 421 });
    expect(checkHost("workstation.tailnet.example", monitor.policy.allowedHosts)).toMatchObject({
      status: 421,
    });
    expect(checkHost("explicit-name", monitor.policy.allowedHosts)).toBe("ok");
    monitor.stop();
  });

  it("deduplicates errors from boot until a successful probe", async () => {
    const timer = clock();
    const warn = vi.fn();
    const monitor = await createNetworkPolicyMonitor(
      {},
      { warn },
      {
        status: async () => {
          throw new Error("missing Tailscale");
        },
        resolve: async () => [],
        schedule: timer.schedule,
      },
    );
    for (let i = 0; i < 30; i++) await timer.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(monitor.policy.bindAddresses).toEqual(["127.0.0.1", "::1"]);
    monitor.stop();
  });

  it("never overlaps probes and ignores an in-flight detection after shutdown", async () => {
    const timer = clock();
    const pending = Promise.withResolvers<string>();
    const status = vi.fn().mockResolvedValueOnce("{}").mockReturnValueOnce(pending.promise);
    const monitor = await createNetworkPolicyMonitor(
      {},
      { warn: vi.fn() },
      {
        status,
        resolve: async () => [],
        schedule: timer.schedule,
      },
    );
    const changed = vi.fn();
    monitor.policy.subscribe?.(changed);
    await timer.tick();
    expect(timer.pending()).toBe(false);
    expect(status).toHaveBeenCalledTimes(2);
    monitor.stop();
    pending.resolve(statusFor(["100.64.0.1"]));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(timer.pending()).toBe(false);
    expect(monitor.policy.bindAddresses).toEqual(["127.0.0.1", "::1"]);
  });

  it("keeps loopback-only dev working without Tailscale or a polling timer", async () => {
    const timer = clock();
    const monitor = await createNetworkPolicyMonitor(
      { DISPATCH_BIND: "loopback" },
      { warn: vi.fn() },
      {
        status: async () => {
          throw new Error("not installed");
        },
        resolve: async () => [],
        schedule: timer.schedule,
      },
    );
    expect(monitor.policy.bindAddresses).toEqual(["127.0.0.1", "::1"]);
    expect(timer.schedule).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("isolates subscriber failures and does not notify disposed subscribers", async () => {
    const timer = clock();
    let raw = "{}";
    const warn = vi.fn();
    const monitor = await createNetworkPolicyMonitor(
      {},
      { warn },
      {
        status: async () => raw,
        resolve: async () => [],
        schedule: timer.schedule,
      },
    );
    monitor.policy.subscribe?.(() => {
      throw new Error("broken transport");
    });
    const healthy = vi.fn();
    monitor.policy.subscribe?.(healthy);
    const disposed = vi.fn();
    monitor.policy.subscribe?.(disposed)?.();
    raw = statusFor(["100.64.0.1"]);
    await timer.tick();
    expect(healthy).toHaveBeenCalledOnce();
    expect(disposed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("network: policy subscriber failed");
    expect(timer.pending()).toBe(true);
    monitor.stop();
    const late = vi.fn();
    monitor.policy.subscribe?.(late);
    expect(late).not.toHaveBeenCalled();
    expect(timer.pending()).toBe(false);
  });

  it("starts with no listeners for tailscale-only and caches explicit DNS binds", async () => {
    const timer = clock();
    let raw = "{}";
    const resolve = vi.fn(async () => ["127.0.0.1"]);
    const monitor = await createNetworkPolicyMonitor(
      { DISPATCH_BIND: "tailscale,custom" },
      { warn: vi.fn() },
      {
        status: async () => raw,
        resolve,
        schedule: timer.schedule,
      },
    );
    expect(monitor.policy.bindAddresses).toEqual(["127.0.0.1"]);
    raw = JSON.stringify({ Self: { TailscaleIPs: ["100.64.0.1", "::", "0.0.0.0"] } });
    await timer.tick();
    expect(monitor.policy.bindAddresses).toEqual(["127.0.0.1", "100.64.0.1"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    monitor.stop();
    const only = await createNetworkPolicyMonitor(
      { DISPATCH_BIND: "tailscale" },
      { warn: vi.fn() },
      {
        status: async () => "{}",
        resolve,
        schedule: timer.schedule,
      },
    );
    expect(only.policy.bindAddresses).toEqual([]);
    expect(timer.pending()).toBe(true);
    only.stop();
  });
});
