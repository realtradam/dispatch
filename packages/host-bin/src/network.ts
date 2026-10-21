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

/** Only a validated response is evidence for withdrawing previously discovered authority.
 * Missing Self/IP fields in a running/unknown state are an incomplete probe, not logout.
 */
function validateStatus(raw: string): string {
  const status: unknown = JSON.parse(raw);
  if (!status || typeof status !== "object" || Array.isArray(status))
    throw new Error("Invalid Tailscale status");
  if ("BackendState" in status && typeof status.BackendState !== "string")
    throw new Error("Invalid Tailscale backend state");
  if (
    "BackendState" in status &&
    ["Stopped", "NeedsLogin", "NeedsMachineAuth"].includes(status.BackendState as string)
  )
    return JSON.stringify({ Self: { TailscaleIPs: [] } });
  if (
    !("Self" in status) ||
    !status.Self ||
    typeof status.Self !== "object" ||
    Array.isArray(status.Self)
  )
    throw new Error("Missing Tailscale Self");
  const self = status.Self as Record<string, unknown>;
  if (
    !("TailscaleIPs" in self) ||
    (self.TailscaleIPs !== null && !Array.isArray(self.TailscaleIPs))
  )
    throw new Error("Missing or invalid Tailscale IP list");
  for (const ip of self.TailscaleIPs ?? []) {
    if (typeof ip !== "string" || !isIP(ip)) throw new Error("Invalid Tailscale IP");
  }
  for (const field of ["HostName", "DNSName"] as const) {
    const value = self[field];
    if (value != null && (typeof value !== "string" || (value !== "" && !normalizeHost(value))))
      throw new Error("Invalid Tailscale name");
  }
  return raw;
}

async function detectDiscoveredPolicy(
  env: Readonly<Record<string, string | undefined>>,
  effects: NetworkDetectionEffects,
): Promise<Pick<NetworkPolicySnapshot, "allowedHosts" | "tailscaleIps">> {
  const status = validateStatus(await effects.status());
  const self = JSON.parse(status).Self;
  const allowedHosts = new Set(buildAllowedHosts({ tailscaleStatusJson: status, env }));
  const tailscaleIps: string[] = [];
  for (const ip of self.TailscaleIPs ?? []) {
    if (ip !== "0.0.0.0" && normalizeHost(ip) !== "::") tailscaleIps.push(normalizeHost(ip));
  }
  // No hostname verification is needed when the status positively has no IPs.
  if (self.HostName && tailscaleIps.length) {
    const ips = await effects.resolve(self.HostName);
    const hostname = normalizeHost(self.HostName);
    if (hostname && ips.some((ip) => tailscaleIps.includes(normalizeHost(ip))))
      allowedHosts.add(hostname);
  }
  return { allowedHosts, tailscaleIps };
}

/** Boot remains tolerant: no discovery means loopback and explicit settings. */
export async function detectNetworkPolicy(
  env: Readonly<Record<string, string | undefined>>,
  logger: Pick<Logger, "warn">,
  effects: NetworkDetectionEffects = detectionEffects,
): Promise<NetworkPolicySnapshot> {
  let discovered: Pick<NetworkPolicySnapshot, "allowedHosts" | "tailscaleIps"> = {
    allowedHosts: buildAllowedHosts({ env }),
    tailscaleIps: [],
  };
  try {
    discovered = await detectDiscoveredPolicy(env, effects);
  } catch {
    logger.warn(
      "network: Tailscale detection unavailable; using loopback and explicit env settings",
    );
  }
  const { addresses: bindAddresses, warnings } = await resolveBindTokens(env.DISPATCH_BIND, {
    tailscaleIps: discovered.tailscaleIps,
    resolveHostname: effects.resolve,
  });
  for (const warning of warnings) logger.warn(`network: ${warning}`);
  if (bindAddresses.length === 0 && !includesTailscale(env.DISPATCH_BIND))
    throw new Error("network: no bind addresses resolved");
  return { ...discovered, bindAddresses };
}

export interface NetworkMonitorEffects extends NetworkDetectionEffects {
  /** One-shot timer, scheduled only after the previous detection settles. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

/** Composition-root owner. No transport dependency; each subscriber owns its listeners.
 * Failed probes retain last-known-good discovery; only validated status can revoke it.
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
    const detected = await detectDiscoveredPolicy(env, effects);
    return {
      ...detected,
      bindAddresses: [...new Set([...fixed.addresses, ...detected.tailscaleIps])],
    };
  };
  let failed = false;
  const warnFailure = () => {
    // One warning per uninterrupted error streak, including a boot failure.
    if (!failed)
      logger.warn(
        "network: Tailscale probe failed; retaining last-known-good policy and retrying in 10s",
      );
    failed = true;
  };
  let current: NetworkPolicySnapshot;
  if (dynamic) {
    current = {
      allowedHosts: buildAllowedHosts({ env }),
      bindAddresses: fixed.addresses,
      tailscaleIps: [],
    };
    try {
      current = await detect();
    } catch {
      warnFailure();
    }
  } else {
    current = await detectNetworkPolicy(env, logger, effects);
  }
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
      if (stopped) return;
      failed = false;
      if (sameNetworkPolicy(current, next)) return;
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
      if (!stopped) warnFailure();
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
