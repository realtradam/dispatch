import { describe, expect, it } from "vitest";
import {
  buildAllowedHosts,
  checkHost,
  checkOrigin,
  corsOriginFor,
  includesTailscale,
  normalizeHost,
  resolveBindTokens,
  sameNetworkPolicy,
} from "./index.js";

const tailscaleStatusJson = JSON.stringify({
  Self: {
    HostName: "laptop",
    DNSName: "PII_REDACTED_TAILSCALE_HOST_01.",
    TailscaleIPs: ["PII_REDACTED_DEV_IPV4_01", "PII_REDACTED_DEV_IPV6_01"],
  },
});
const allowed = buildAllowedHosts({ tailscaleStatusJson, env: {} });

describe("host and Origin policy", () => {
  it.each([
    ["PII_REDACTED_DEVICE_01", "PII_REDACTED_DEVICE_01"],
    ["PII_REDACTED_DEVICE_01", "PII_REDACTED_DEVICE_01"],
    ["PII_REDACTED_TAILSCALE_HOST_01.", "PII_REDACTED_TAILSCALE_HOST_01"],
    ["PII_REDACTED_DEV_IPV4_01:24203", "PII_REDACTED_DEV_IPV4_01"],
    ["[PII_REDACTED_DEV_IPV6_01]:24205", "PII_REDACTED_DEV_IPV6_01"],
    ["localhost:24204", "localhost"],
    ["[::1]", "::1"],
    ["127.0.0.1", "127.0.0.1"],
    ["LOCALHOST.:443", "localhost"],
    ["[0:0:0:0:0:0:0:1]:80", "::1"],
  ])("allows and normalizes %s", (raw, normalized) => {
    expect(normalizeHost(raw)).toBe(normalized);
    expect(checkHost(raw, allowed)).toBe("ok");
    for (const scheme of ["http", "https"]) {
      const origin = `${scheme}://${raw}`;
      expect(checkOrigin(origin, allowed)).toBe("ok");
      expect(corsOriginFor(origin, allowed)).toBe(origin);
    }
  });

  it.each([
    "evil.com",
    "PII_REDACTED_DEVICE_01.evil.com",
    "PII_REDACTED_DEV_IPV4_01.nip.io",
    "laptop",
    "localhost@evil.com",
    "evil.com@localhost",
    "localhost/path",
    "localhost:bad",
    "localhost:65536",
    "localhost:",
    "[::1]suffix",
    "[localhost]",
    "[127.0.0.1]",
    "localhost\n",
    "localhost:80\n",
    "::1\n",
    "localhost,evil.com",
    "localhost\\evil.com",
    "localhost\r\n",
    "",
    "localhost..",
    "%6cocalhost",
  ])("rejects untrusted or malformed Host %j", (host) => {
    expect(checkHost(host, allowed)).toMatchObject({ status: 421 });
    expect(checkOrigin(`http://${host}`, allowed)).toMatchObject({ status: 403 });
  });

  it.each([
    "null",
    "file://",
    "file://localhost",
    "ws://localhost",
    "https://evil.com",
    "http://localhost/",
    "http://localhost?x",
    "http://localhost#x",
    "http://user@localhost",
    "http://localhost https://localhost",
    "http:localhost",
    "",
  ])("rejects Origin %j without reflecting it", (origin) => {
    expect(checkOrigin(origin, allowed)).toMatchObject({ status: 403 });
    expect(corsOriginFor(origin, allowed)).toBeNull();
  });

  it("permits absent Origin but requires Host", () => {
    for (const missing of [undefined, null]) {
      expect(checkHost(missing, allowed)).toMatchObject({ status: 421 });
      expect(checkOrigin(missing, allowed)).toBe("ok");
      expect(corsOriginFor(missing, allowed)).toBeNull();
    }
  });
});

describe("allowed host construction", () => {
  it.each([
    undefined,
    "invalid",
    "null",
    "[]",
    "{}",
    '{"Self":null}',
  ])("falls back to loopback for %j", (json) => {
    const input = json === undefined ? { env: {} } : { tailscaleStatusJson: json, env: {} };
    expect([...buildAllowedHosts(input)]).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  it("adds explicit env hosts and fallback name without ambient state", () => {
    expect([
      ...buildAllowedHosts({
        env: {
          DISPATCH_ALLOWED_HOSTS: " EXTRA.example.:8080, [::1], , https://evil.com",
          DISPATCH_TAILSCALE_NAME: "PII_REDACTED_DEVICE_01",
        },
      }),
    ]).toEqual(["localhost", "127.0.0.1", "::1", "extra.example", "PII_REDACTED_DEVICE_01"]);
  });

  it("ignores malformed fields without discarding valid Tailscale IPs", () => {
    expect([
      ...buildAllowedHosts({
        env: {},
        tailscaleStatusJson: JSON.stringify({
          Self: {
            DNSName: 42,
            TailscaleIPs: [null, "evil.com", "0.0.0.0", "PII_REDACTED_DEV_IPV4_01"],
          },
        }),
      }),
    ]).toEqual(["localhost", "127.0.0.1", "::1", "0.0.0.0", "PII_REDACTED_DEV_IPV4_01"]);
  });
});

describe("bind token resolution", () => {
  const tailscaleIps = ["PII_REDACTED_DEV_IPV4_01", "PII_REDACTED_DEV_IPV6_01"];
  it("defaults to loopback and Tailscale and deduplicates in order", async () => {
    const expected = ["127.0.0.1", "::1", ...tailscaleIps];
    expect(await resolveBindTokens(undefined, { tailscaleIps })).toEqual({
      addresses: expected,
      warnings: [],
    });
    expect(
      (await resolveBindTokens("loopback,tailscale,127.0.0.1,[::1]", { tailscaleIps })).addresses,
    ).toEqual(expected);
  });

  it("handles literal IPs and warns loudly for all", async () => {
    expect(await resolveBindTokens("192.168.1.2,::1", { tailscaleIps: [] })).toEqual({
      addresses: ["192.168.1.2", "::1"],
      warnings: [],
    });
    const result = await resolveBindTokens("all,0.0.0.0,::", { tailscaleIps: [] });
    expect(result.addresses).toEqual(["0.0.0.0", "::"]);
    expect(result.warnings.join(" ")).toContain("all interfaces");
  });

  it("uses only the injected DNS resolver and validates its answers", async () => {
    const calls: string[] = [];
    const result = await resolveBindTokens("PII_REDACTED_DEVICE_01.,loopback", {
      tailscaleIps,
      resolveHostname: async (name) => {
        calls.push(name);
        return [tailscaleIps[0] ?? "", "not-an-ip", "127.0.0.1"];
      },
    });
    expect(calls).toEqual(["PII_REDACTED_DEVICE_01"]);
    expect(result.addresses).toEqual([tailscaleIps[0], "127.0.0.1", "::1"]);
    expect(result.warnings).toHaveLength(1);
  });

  it("reports unavailable Tailscale, missing DNS, failed DNS and empty results", async () => {
    expect((await resolveBindTokens(undefined, { tailscaleIps: [] })).warnings).toHaveLength(1);
    expect((await resolveBindTokens("PII_REDACTED_DEVICE_01", { tailscaleIps: [] })).warnings).toHaveLength(1);
    for (const resolveHostname of [
      () => {
        throw new Error("offline");
      },
      () => [],
    ]) {
      expect(
        await resolveBindTokens("PII_REDACTED_DEVICE_01", { tailscaleIps: [], resolveHostname }),
      ).toMatchObject({ addresses: [], warnings: [expect.any(String)] });
    }
    expect((await resolveBindTokens("localhost:80", { tailscaleIps: [] })).warnings).toHaveLength(
      1,
    );
  });
});

describe("live policy decisions", () => {
  it.each([
    [undefined, true],
    ["loopback", false],
    ["tailscale", true],
    ["loopback, TAILSCALE ", true],
    ["my-tailscale-host", false],
    ["all", false],
  ])("detects only the exact Tailscale token in %s", (spec, expected) => {
    expect(includesTailscale(spec)).toBe(expected);
  });
  it("compares all policy fields without depending on address order", () => {
    const initial = {
      allowedHosts: new Set(["localhost", "arch"]),
      bindAddresses: ["127.0.0.1", "100.64.0.1"],
      tailscaleIps: ["100.64.0.1"],
    };
    expect(
      sameNetworkPolicy(initial, {
        ...initial,
        allowedHosts: new Set(["arch", "localhost"]),
        bindAddresses: ["100.64.0.1", "127.0.0.1"],
      }),
    ).toBe(true);
    expect(sameNetworkPolicy(initial, { ...initial, allowedHosts: new Set(["localhost"]) })).toBe(
      false,
    );
    expect(sameNetworkPolicy(initial, { ...initial, bindAddresses: ["127.0.0.1"] })).toBe(false);
    expect(sameNetworkPolicy(initial, { ...initial, tailscaleIps: [] })).toBe(false);
  });
});
