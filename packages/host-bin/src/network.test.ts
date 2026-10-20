import { describe, expect, it, vi } from "vitest";
import { detectNetworkPolicy } from "./network.js";

describe("boot network edge", () => {
  it("detects once, verifies OS hostname, and resolves bind names", async () => {
    const status = vi.fn(async () =>
      JSON.stringify({
        Self: {
          DNSName: "PII_REDACTED_TAILSCALE_HOST_01.",
          HostName: "laptop",
          TailscaleIPs: ["PII_REDACTED_DEV_IPV4_01"],
        },
      }),
    );
    const policy = await detectNetworkPolicy(
      { DISPATCH_BIND: "loopback,tailscale,extra" },
      { warn: vi.fn() },
      {
        status,
        resolve: async () => ["PII_REDACTED_DEV_IPV4_01"],
      },
    );
    expect(status).toHaveBeenCalledTimes(1);
    expect(policy.allowedHosts.has("PII_REDACTED_DEVICE_01")).toBe(true);
    expect(policy.allowedHosts.has("laptop")).toBe(true);
    expect(policy.bindAddresses).toEqual(["127.0.0.1", "::1", "PII_REDACTED_DEV_IPV4_01"]);
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
          JSON.stringify({ Self: { HostName: "laptop", TailscaleIPs: ["PII_REDACTED_DEV_IPV4_01"] } }),
        resolve: async () => ["192.168.1.2"],
      },
    );
    expect(policy.allowedHosts.has("laptop")).toBe(false);
  });
});
