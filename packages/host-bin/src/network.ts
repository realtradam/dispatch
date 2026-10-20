import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import type { Logger } from "@dispatch/kernel";
import { buildAllowedHosts, normalizeHost, resolveBindTokens } from "@dispatch/network-policy";

/** Boot-only I/O edge. Both transports receive this same snapshot via config. */
export async function detectNetworkPolicy(
  env: Readonly<Record<string, string | undefined>>,
  logger: Pick<Logger, "warn">,
  effects = {
    status: async () =>
      (await promisify(execFile)("tailscale", ["status", "--self", "--json"], { timeout: 2000 }))
        .stdout,
    resolve: async (name: string) => (await lookup(name, { all: true })).map((r) => r.address),
  },
) {
  let status: string | undefined;
  try {
    status = await effects.status();
  } catch {
    logger.warn(
      "network: Tailscale detection unavailable; using loopback and explicit env settings",
    );
  }
  const allowedHosts = new Set(
    buildAllowedHosts({
      ...(status !== undefined ? { tailscaleStatusJson: status } : {}),
      env: {
        ...(env.DISPATCH_ALLOWED_HOSTS !== undefined
          ? { DISPATCH_ALLOWED_HOSTS: env.DISPATCH_ALLOWED_HOSTS }
          : {}),
        ...(env.DISPATCH_TAILSCALE_NAME !== undefined
          ? { DISPATCH_TAILSCALE_NAME: env.DISPATCH_TAILSCALE_NAME }
          : {}),
      },
    }),
  );
  const tailscaleIps: string[] = [];
  try {
    const self = JSON.parse(status ?? "{}").Self;
    for (const ip of self?.TailscaleIPs ?? []) {
      if (typeof ip === "string" && isIP(ip)) tailscaleIps.push(ip);
    }
    if (typeof self?.HostName === "string") {
      const ips = await effects.resolve(self.HostName);
      if (ips.some((ip) => tailscaleIps.includes(ip)))
        allowedHosts.add(normalizeHost(self.HostName));
    }
  } catch {
    // Missing/malformed status or unresolvable OS hostname: never widen the allowlist.
  }
  const { addresses: bindAddresses, warnings } = await resolveBindTokens(env.DISPATCH_BIND, {
    tailscaleIps,
    resolveHostname: effects.resolve,
  });
  for (const warning of warnings) logger.warn(`network: ${warning}`);
  if (bindAddresses.length === 0) throw new Error("network: no bind addresses resolved");
  return { allowedHosts, bindAddresses, tailscaleIps };
}
