/** Pure network policy. No environment reads, DNS calls, subprocesses or listeners. */
export interface NetworkPolicySnapshot {
  readonly allowedHosts: ReadonlySet<string>;
  readonly bindAddresses: readonly string[];
  readonly tailscaleIps: readonly string[];
}

/** Host-owned live config. Plain snapshots remain valid for embedded transports.
 * Publication precedes synchronous notifications; subscribe does not replay.
 * Disposing a subscription prevents further notifications (including after unload).
 */
export interface NetworkPolicyConfig extends NetworkPolicySnapshot {
  readonly subscribe?: (listener: (snapshot: NetworkPolicySnapshot) => void) => () => void;
}

/** Default bind policy includes Tailscale; explicit loopback-only needs no polling. */
export function includesTailscale(spec: string | undefined): boolean {
  return (spec ?? "loopback,tailscale")
    .split(",")
    .some((token) => token.trim().toLowerCase() === "tailscale");
}

/** Order-independent equality avoids restarting/re-notifying on status ordering noise. */
export function sameNetworkPolicy(a: NetworkPolicySnapshot, b: NetworkPolicySnapshot): boolean {
  const same = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
    left.size === right.size && [...left].every((value) => right.has(value));
  return (
    same(a.allowedHosts, b.allowedHosts) &&
    same(new Set(a.bindAddresses), new Set(b.bindAddresses)) &&
    same(new Set(a.tailscaleIps), new Set(b.tailscaleIps))
  );
}
export interface NetworkPolicyEnv {
  readonly DISPATCH_ALLOWED_HOSTS?: string;
  readonly DISPATCH_TAILSCALE_NAME?: string;
}

export type PolicyDecision<Status extends number> = "ok" | { status: Status; reason: string };
type HeaderValue = string | null | undefined;

function ipAddress(raw: string): string {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) {
    return raw.split(".").every((part) => Number(part) <= 255 && String(Number(part)) === part)
      ? raw
      : "";
  }
  if (!raw.includes(":") || /[^\da-f:.]/i.test(raw)) return "";
  try {
    return new URL(`http://[${raw}]`).hostname.slice(1, -1);
  } catch {
    return "";
  }
}

/** Invalid authorities normalize to "" (fail closed). Bare IPv6 is also accepted. */
export function normalizeHost(raw: string): string {
  const host = raw.toLowerCase();
  if (host.includes(":") && !host.startsWith("[") && host.split(":").length > 2) {
    return ipAddress(host);
  }
  const match = /^(?:\[([\da-f:.]+)\]|([^\s:/\\@?#[\],%]+))(?::(\d+))?$/.exec(host);
  if (!match || match[0] !== host || (match[3] !== undefined && Number(match[3]) > 65535)) {
    return "";
  }
  if (match[1]) return match[1].includes(":") ? ipAddress(match[1]) : "";
  const name = (match[2] ?? "").replace(/\.$/, "");
  return name.length <= 253 &&
    name.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
    ? name
    : "";
}

/** OS HostName is deliberately not trusted; the shell may add it after verifying DNS. */
export function buildAllowedHosts(input: {
  tailscaleStatusJson?: string;
  env: NetworkPolicyEnv;
}): ReadonlySet<string> {
  const allowed = new Set(["localhost", "127.0.0.1", "::1"]);
  const add = (raw: string) => {
    const normalized = normalizeHost(raw);
    if (normalized) allowed.add(normalized);
  };
  try {
    const status: unknown = JSON.parse(input.tailscaleStatusJson ?? "null");
    if (status && typeof status === "object" && "Self" in status) {
      const self = status.Self;
      if (self && typeof self === "object") {
        if ("DNSName" in self && typeof self.DNSName === "string") {
          const name = normalizeHost(self.DNSName);
          if (name) {
            add(name);
            add(name.split(".")[0] ?? "");
          }
        }
        if ("TailscaleIPs" in self && Array.isArray(self.TailscaleIPs)) {
          for (const ip of self.TailscaleIPs) {
            if (typeof ip === "string" && ipAddress(ip)) add(ip);
          }
        }
      }
    }
  } catch {
    // Missing/malformed status must leave the loopback and explicit env policy intact.
  }
  for (const host of (input.env.DISPATCH_ALLOWED_HOSTS ?? "").split(",")) add(host.trim());
  if (input.env.DISPATCH_TAILSCALE_NAME) add(input.env.DISPATCH_TAILSCALE_NAME.trim());
  return allowed;
}

export function checkHost(
  hostHeader: HeaderValue,
  allowed: ReadonlySet<string>,
): PolicyDecision<421> {
  const host = hostHeader == null ? "" : normalizeHost(hostHeader);
  return host && allowed.has(host) ? "ok" : { status: 421, reason: "Host is not allowed" };
}

export function checkOrigin(
  originHeader: HeaderValue,
  allowed: ReadonlySet<string>,
): PolicyDecision<403> {
  if (originHeader == null) return "ok";
  const match = /^https?:\/\/([^/\\?#\s]+)$/i.exec(originHeader);
  if (match?.[1] && match[0] === originHeader && checkHost(match[1], allowed) === "ok") {
    try {
      new URL(originHeader);
      return "ok";
    } catch {
      // Reject malformed URL authorities even if they resemble an allowed hostname.
    }
  }
  return { status: 403, reason: "Origin is not allowed" };
}

/** Reflect the original allowed Origin, never a wildcard. The shell must set Vary: Origin. */
export function corsOriginFor(origin: HeaderValue, allowed: ReadonlySet<string>): string | null {
  return origin != null && checkOrigin(origin, allowed) === "ok" ? origin : null;
}

export interface BindResolutionOptions {
  readonly tailscaleIps: readonly string[];
  /** Inject DNS at the shell; a pre-resolved synchronous lookup is also supported. */
  readonly resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]>;
}

/** Stable token/address order; invalid or unavailable tokens yield warnings, not wildcards. */
export async function resolveBindTokens(
  spec: string | undefined,
  options: BindResolutionOptions,
): Promise<{ addresses: string[]; warnings: string[] }> {
  const addresses = new Set<string>();
  const warnings: string[] = [];
  const addIps = (ips: readonly string[]) => {
    for (const ip of ips) {
      const normalized = ipAddress(ip);
      if (normalized) addresses.add(normalized);
      else warnings.push(`Ignoring invalid bind IP: ${ip}`);
    }
  };
  for (const raw of (spec ?? "loopback,tailscale").split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === "loopback") addIps(["127.0.0.1", "::1"]);
    else if (token === "tailscale") {
      if (!options.tailscaleIps.length) warnings.push("No Tailscale IPs detected");
      addIps(options.tailscaleIps);
    } else if (token === "all") {
      addIps(["0.0.0.0", "::"]);
      warnings.push("WARNING: binding all interfaces exposes Dispatch outside loopback/Tailscale");
    } else {
      const literal = ipAddress(token.replace(/^\[(.*)\]$/, "$1"));
      const hostname = normalizeHost(token);
      if (literal) addIps([literal]);
      else if (
        !hostname ||
        (token !== hostname && token !== `${hostname}.`) ||
        !options.resolveHostname
      ) {
        warnings.push(`Cannot resolve bind hostname: ${token}`);
      } else {
        try {
          const ips = await options.resolveHostname(hostname);
          if (!ips.length) warnings.push(`No bind addresses resolved for: ${token}`);
          addIps(ips);
        } catch {
          warnings.push(`Failed to resolve bind hostname: ${token}`);
        }
      }
    }
  }
  return { addresses: [...addresses], warnings };
}
