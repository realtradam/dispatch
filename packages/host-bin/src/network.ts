import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import type { Logger } from "@dispatch/kernel";
import {
  buildAllowedHosts,
  includesTailscale,
  type NetworkPolicyConfig,
  type NetworkPolicySnapshot,
  normalizeHost,
  resolveBindTokens,
  sameNetworkPolicy,
} from "@dispatch/network-policy";

export interface NetworkDetectionEffects {
  readonly status: () => Promise<string>;
  readonly resolve: (name: string) => Promise<string[]>;
}

const detectionEffects: NetworkDetectionEffects = {
  status: async () =>
    (await promisify(execFile)("tailscale", ["status", "--self", "--json"], { timeout: 2000 }))
      .stdout,
  resolve: async (name) => {
    // lookup has no cancellation API. Bound the wait, and observe late rejection.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        lookup(name, { all: true }).then((rows) => rows.map((row) => row.address)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("DNS lookup timed out")), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  },
};

/** One detection at the I/O edge; a missing tailnet may have zero pending listeners. */
export async function detectNetworkPolicy(
  env: Readonly<Record<string, string | undefined>>,
  logger: Pick<Logger, "warn">,
  effects: NetworkDetectionEffects = detectionEffects,
): Promise<NetworkPolicySnapshot> {
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
      if (typeof ip === "string" && isIP(ip) && ip !== "0.0.0.0" && normalizeHost(ip) !== "::")
        tailscaleIps.push(normalizeHost(ip));
    }
    if (typeof self?.HostName === "string") {
      const ips = await effects.resolve(self.HostName);
      const hostname = normalizeHost(self.HostName);
      if (hostname && ips.some((ip) => tailscaleIps.includes(normalizeHost(ip))))
        allowedHosts.add(hostname);
    }
  } catch {
    // Missing/malformed status or unresolvable OS hostname: never widen the allowlist.
  }
  const { addresses: bindAddresses, warnings } = await resolveBindTokens(env.DISPATCH_BIND, {
    tailscaleIps,
    resolveHostname: effects.resolve,
  });
  for (const warning of warnings) logger.warn(`network: ${warning}`);
  if (bindAddresses.length === 0 && !includesTailscale(env.DISPATCH_BIND))
    throw new Error("network: no bind addresses resolved");
  return { allowedHosts, bindAddresses, tailscaleIps };
}

export interface NetworkMonitorEffects extends NetworkDetectionEffects {
  /** One-shot timer, scheduled only after the previous detection settles. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

/** Composition-root owner. No transport dependency; each subscriber owns its listeners.
 * Failed detection revokes discovered hosts/IPs rather than accumulating stale authority.
 * Explicit bind names are resolved once, not polled into a broader interface set.
 */
export async function createNetworkPolicyMonitor(
  inputEnv: Readonly<Record<string, string | undefined>>,
  logger: Pick<Logger, "warn">,
  effects: NetworkMonitorEffects = {
    ...detectionEffects,
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      // Keep tailscale-only hosts alive even while no addresses are assigned.
      return () => clearTimeout(timer);
    },
  },
) {
  const env = { ...inputEnv };
  const dynamic = includesTailscale(env.DISPATCH_BIND);
  // Cache explicit bind DNS separately from the verified Self.HostName lookup.
  const fixedSpec = (env.DISPATCH_BIND ?? "loopback,tailscale")
    .split(",")
    .filter((token) => token.trim().toLowerCase() !== "tailscale")
    .join(",");
  const fixed = dynamic
    ? await resolveBindTokens(fixedSpec, { tailscaleIps: [], resolveHostname: effects.resolve })
    : { addresses: [], warnings: [] };
  for (const warning of fixed.warnings) logger.warn(`network: ${warning}`);
  const detect = async (): Promise<NetworkPolicySnapshot> => {
    const detected = await detectNetworkPolicy(
      { ...env, DISPATCH_BIND: "tailscale" },
      logger,
      effects,
    );
    return {
      ...detected,
      bindAddresses: [...new Set([...fixed.addresses, ...detected.tailscaleIps])],
    };
  };
  let current = dynamic ? await detect() : await detectNetworkPolicy(env, logger, effects);
  const subscribers = new Set<(snapshot: NetworkPolicySnapshot) => void>();
  let stopped = false;
  let cancelTimer: (() => void) | undefined;
  const policy: NetworkPolicyConfig = {
    get allowedHosts() {
      return current.allowedHosts;
    },
    get bindAddresses() {
      return current.bindAddresses;
    },
    get tailscaleIps() {
      return current.tailscaleIps;
    },
    subscribe(listener) {
      if (!stopped) subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  };
  const schedule = () => {
    if (!stopped && dynamic)
      cancelTimer = effects.schedule(() => {
        void poll();
      }, 10_000);
  };
  const poll = async () => {
    try {
      const next = await detect();
      if (stopped || sameNetworkPolicy(current, next)) return;
      current = next;
      logger.warn("network: refreshed Tailscale policy", {
        addresses: next.bindAddresses.join(","),
      });
      for (const listener of subscribers) {
        try {
          listener(current);
        } catch {
          logger.warn("network: policy subscriber failed");
        }
      }
    } catch {
      logger.warn("network: policy refresh failed; retrying in 10s");
    } finally {
      schedule();
    }
  };
  schedule();
  return {
    policy,
    stop() {
      stopped = true;
      cancelTimer?.();
      subscribers.clear();
    },
  };
}
