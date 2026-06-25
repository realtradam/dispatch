/**
 * ~/.ssh/config reader — pure discovery of `Computer`s from an SSH config.
 *
 * Per decision #4: computers are DISCOVERED read-only (no CRUD). A "computer"
 * is a named (non-wildcard) `Host` alias in the system's `~/.ssh/config`. This
 * module is the PURE half: it takes the config TEXT + known_hosts TEXT (the I/O
 * of reading the files lives in the shell) and resolves each alias to a
 * `Computer`. Uses the `ssh-config` package for correct parsing (wildcards,
 * `Include`, first-match-wins) rather than a hand-rolled parser (decision #8).
 *
 * Pure: zero I/O, zero mocks — a test feeds fixture strings. The shell
 * (`service.ts`) injects the file contents.
 */

import type { Computer } from "@dispatch/wire";
import SSHConfig, { type Directive, type Section } from "ssh-config";
import { isKnownHost } from "./hostkey.js";

/** Injected environment for the pure resolver (no ambient process access). */
export interface SshConfigResolveEnv {
	/** The raw `~/.ssh/config` text. */
	readonly configText: string;
	/** The raw `~/.ssh/known_hosts` text (drives `knownHost`). */
	readonly knownHostsText: string;
	/** Fallback user when the config sets none (the current OS user). */
	readonly defaultUser: string;
	/** Home dir, for resolving `~` in `IdentityFile` (already-expanded by caller). */
	readonly homeDir: string;
}

/**
 * Parse `~/.ssh/config` and return one `Computer` per named (non-wildcard)
 * `Host` alias, with resolved `hostName`/`port`/`user`/`identityFile`/
 * `knownHost`. Wildcard hosts (`*`, `?.example.com`) are NOT computers (they
 * are patterns, not selectable targets) — skipped. Sorted by `alias`.
 *
 * `knownHost` reflects whether the resolved HostName appears in
 * `~/.ssh/known_hosts` (drives the FE "known/new" indicator).
 *
 * Pure: `SshConfigResolveEnv` → `readonly Computer[]`.
 */
export function resolveComputers(env: SshConfigResolveEnv): readonly Computer[] {
	const config = SSHConfig.parse(env.configText);
	const computers: Computer[] = [];

	for (const line of config) {
		// Only `Host` sections define aliases; `Match`/standalone directives aren't
		// selectable computers.
		if (!isHostSection(line)) continue;
		const aliases = readAliasValues(line);
		for (const alias of aliases) {
			if (isWildcardAlias(alias)) continue; // patterns, not targets
			const computer = resolveOne(config, alias, env);
			if (computer !== null) computers.push(computer);
		}
	}

	// De-dup by alias (a host may be listed in multiple `Host` lines; first wins
	// per OpenSSH), then sort for stable FE ordering.
	const seen = new Set<string>();
	const unique = computers.filter((c) => {
		if (seen.has(c.alias)) return false;
		seen.add(c.alias);
		return true;
	});
	unique.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
	return unique;
}

/**
 * Resolve a single alias to a `Computer` (or `null` when the alias isn't a
 * named host). Pure. `compute()` applies OpenSSH first-match-wins + wildcards.
 */
export function resolveComputer(alias: string, env: SshConfigResolveEnv): Computer | null {
	const config = SSHConfig.parse(env.configText);
	if (!aliasExistsAsNamedHost(config, alias)) return null;
	return resolveOne(config, alias, env);
}

/** Resolve one alias using a parsed config. Pure. */
function resolveOne(config: SSHConfig, alias: string, env: SshConfigResolveEnv): Computer | null {
	const computed = config.compute(alias);
	const hostName = stringValue(computed.HostName) ?? alias; // falls back to alias
	const port = numberValue(computed.Port) ?? 22;
	const user = stringValue(computed.User) ?? env.defaultUser;
	const identityFile = identityFileValue(computed.IdentityFile, env);

	// `knownHost` is keyed by the HostName (the actual connect target) — that is
	// what ssh2 connects to and what OpenSSH records in known_hosts.
	const knownHost = isKnownHost(env.knownHostsText, knownHostToken(hostName, port));

	return { alias, hostName, port, user, identityFile, knownHost };
}

// ─── ssh-config line helpers ──────────────────────────────────────────────

function isHostSection(line: SSHConfig[number]): line is Section {
	return "param" in line && (line as Directive).param.toLowerCase() === "host";
}

/** The alias values declared on a `Host` line (space-separated, may be quoted). */
function readAliasValues(section: Section): string[] {
	const value = section.value;
	if (typeof value === "string") return value.split(/\s+/).filter((s) => s.length > 0);
	// Quoted/structured value: array of { val } objects.
	if (Array.isArray(value)) {
		return value.map((v) => (typeof v === "string" ? v : v.val)).filter((s) => s.length > 0);
	}
	return [];
}

/** A `Host` alias is a selectable computer only if it contains no wildcard chars. */
function isWildcardAlias(alias: string): boolean {
	return alias.includes("*") || alias.includes("?");
}

function aliasExistsAsNamedHost(config: SSHConfig, alias: string): boolean {
	for (const line of config) {
		if (!isHostSection(line)) continue;
		const aliases = readAliasValues(line);
		if (aliases.includes(alias) && !aliases.some(isWildcardAlias)) return true;
	}
	return false;
}

// ─── value coercion (ssh-config returns string | string[]) ────────────────

function stringValue(v: string | string[] | undefined): string | undefined {
	if (v === undefined) return undefined;
	return Array.isArray(v) ? v[0] : v;
}

function numberValue(v: string | string[] | undefined): number | undefined {
	const s = stringValue(v);
	if (s === undefined) return undefined;
	const n = Number.parseInt(s, 10);
	return Number.isNaN(n) ? undefined : n;
}

function identityFileValue(
	v: string | string[] | undefined,
	env: SshConfigResolveEnv,
): string | null {
	const raw = stringValue(v);
	if (raw === undefined) return null; // caller falls back to default probing
	return expandPath(raw, env.homeDir);
}

/** Expand a leading `~` to the home dir. (Other $VARs left to the shell.) */
function expandPath(p: string, homeDir: string): string {
	if (p === "~") return homeDir;
	if (p.startsWith("~/")) return `${homeDir}/${p.slice(2)}`;
	return p;
}

/**
 * The token used to key `known_hosts` for a host:port. Mirrors OpenSSH — a
 * non-default port is recorded as `[host]:port`; the default port (22) is just
 * `host`. Used both for the `knownHost` view and by the pool's host-verifier.
 */
export function knownHostToken(hostName: string, port: number): string {
	if (port === 22) return hostName;
	return `[${hostName}]:${port}`;
}
