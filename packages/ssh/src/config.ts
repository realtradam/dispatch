/**
 * Computer discovery — pure resolution of `Computer`s from SSH config +
 * `known_hosts`.
 *
 * Per decision #4: computers are DISCOVERED read-only (no CRUD). Discovery
 * has TWO sources, in precedence order:
 *
 * 1. **`~/.ssh/config`** — named (non-wildcard) `Host` aliases with full
 *    connection params (HostName, Port, User, IdentityFile). These are the
 *    "explicitly configured" computers.
 * 2. **`~/.ssh/known_hosts`** — every hostname you've ever connected to. These
 *    are the "discovered" computers, added with defaulted params (User=
 *    defaultUser, IdentityFile=null → the pool probes default keys, Port
 *    parsed from `[host]:port` notation or 22). A hostname already present in
 *    config is NOT duplicated (config takes precedence).
 *
 * A **reject list** (glob patterns from `dispatch.toml` `[ssh].reject`)
 * filters the final list — e.g. `github.com`, `*.ts.net`, raw IPs — so noise
 * from `known_hosts` doesn't pollute the computer catalog.
 *
 * This module is the PURE half: it takes the config TEXT + known_hosts TEXT +
 * reject patterns (the I/O of reading the files lives in the shell) and
 * resolves each to a `Computer`. Uses the `ssh-config` package for correct
 * parsing (wildcards, `Include`, first-match-wins) rather than a hand-rolled
 * parser (decision #8).
 *
 * Pure: zero I/O, zero mocks — a test feeds fixture strings. The shell
 * (`service.ts`) injects the file contents.
 */

import type { Computer } from "@dispatch/wire";
import SSHConfig, { type Directive, type Section } from "ssh-config";
import { isKnownHost } from "./hostkey.js";

/** Injected environment for the pure resolver (no ambient process access). */
export interface SshConfigResolveEnv {
	/** The raw `~/.ssh/config` text (may be empty — no file). */
	readonly configText: string;
	/** The raw `~/.ssh/known_hosts` text (drives `knownHost` + discovery). */
	readonly knownHostsText: string;
	/** Fallback user when the config sets none (the current OS user). */
	readonly defaultUser: string;
	/** Home dir, for resolving `~` in `IdentityFile` (already-expanded by caller). */
	readonly homeDir: string;
	/**
	 * Glob patterns (e.g. `github.com`, `*.ts.net`) to exclude from the
	 * computer catalog. Sourced from `dispatch.toml` `[ssh].reject`. Absent
	 * or empty → no filtering.
	 */
	readonly rejectPatterns?: readonly string[];
}

/**
 * Discover `Computer`s from `~/.ssh/config` + `~/.ssh/known_hosts`, returning
 * one per unique hostname (config aliases first, then known_hosts entries not
 * already in config), filtered by the reject list.
 *
 * **Sources, in precedence order:**
 * 1. `~/.ssh/config` — named (non-wildcard) `Host` aliases with full params.
 * 2. `~/.ssh/known_hosts` — hostnames you've connected to before, with
 *    defaulted params (User=defaultUser, IdentityFile=null, Port from
 *    `[host]:port` or 22). Not duplicated when already in config.
 *
 * Wildcard hosts (`*`, `?.example.com`) are NOT computers. The reject list
 * (glob patterns) filters the final set. Sorted by `alias`.
 *
 * `knownHost` reflects whether the resolved HostName appears in
 * `~/.ssh/known_hosts` (drives the FE "known/new" indicator).
 *
 * Pure: `SshConfigResolveEnv` → `readonly Computer[]`.
 */
export function resolveComputers(env: SshConfigResolveEnv): readonly Computer[] {
	const config = SSHConfig.parse(env.configText);
	const computers: Computer[] = [];

	// Source 1: ~/.ssh/config — full-param aliases.
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

	const configAliases = new Set(computers.map((c) => c.alias));

	// Source 2: ~/.ssh/known_hosts — discovered hostnames not already in config.
	for (const { hostname, port } of parseKnownHosts(env.knownHostsText)) {
		if (configAliases.has(hostname)) continue; // config takes precedence
		computers.push({
			alias: hostname,
			hostName: hostname,
			port,
			user: env.defaultUser,
			identityFile: null, // pool probes default keys (~/.ssh/id_ed25519, etc.)
			knownHost: true, // it's in known_hosts by definition
		});
	}

	// De-dup by alias (a host may be listed in multiple `Host` lines or appear
	// in both config + known_hosts; first wins), then sort for stable FE ordering.
	const seen = new Set<string>();
	const unique = computers.filter((c) => {
		if (seen.has(c.alias)) return false;
		seen.add(c.alias);
		return true;
	});

	// Filter out rejected hostnames (glob patterns from dispatch.toml).
	const filtered = unique.filter((c) => !isRejected(c.alias, env.rejectPatterns));
	filtered.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
	return filtered;
}

/**
 * Resolve a single alias to a `Computer` (or `null` when the alias isn't a
 * known computer). Checks `~/.ssh/config` first (full params), then
 * `~/.ssh/known_hosts` (defaulted params). Does NOT apply the reject list —
 * a specific lookup always resolves (reject is a discovery/catalog filter,
 * not access control).
 * Pure. `compute()` applies OpenSSH first-match-wins + wildcards.
 */
export function resolveComputer(alias: string, env: SshConfigResolveEnv): Computer | null {
	// Source 1: ~/.ssh/config.
	const config = SSHConfig.parse(env.configText);
	if (aliasExistsAsNamedHost(config, alias)) {
		return resolveOne(config, alias, env);
	}

	// Source 2: ~/.ssh/known_hosts (defaulted params).
	const knownHosts = parseKnownHosts(env.knownHostsText);
	const entry = knownHosts.find((h) => h.hostname === alias);
	if (entry !== undefined) {
		return {
			alias: entry.hostname,
			hostName: entry.hostname,
			port: entry.port,
			user: env.defaultUser,
			identityFile: null,
			knownHost: true,
		};
	}

	return null;
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

// ─── known_hosts discovery ─────────────────────────────────────────────────

/** Find the index of the first space or tab, or -1 if none. */
function findSpace(line: string): number {
	for (let i = 0; i < line.length; i++) {
		const ch = line.charCodeAt(i);
		if (ch === 32 || ch === 9) return i; // space or tab
	}
	return -1;
}

/** A hostname + port extracted from a `~/.ssh/known_hosts` line. */
export interface KnownHostEntry {
	readonly hostname: string;
	readonly port: number;
}

/**
 * Parse `~/.ssh/known_hosts` and return one entry per unique hostname with
 * its port. Skips hashed entries (`|1|...` — can't reverse the hash), comment
 * lines, and entries with no parseable hostname. Deduplicates by hostname
 * (first port wins — so a host with both `host` and `[host]:2222` entries
 * keeps whichever appears first).
 *
 * Each known_hosts line is: `hostmarkers keytype key [comment]`
 * where `hostmarkers` is comma-separated, each marker being:
 * - `hostname` (e.g. `myserver`) → port 22
 * - `[hostname]:port` (e.g. `[myserver]:2222`)
 * - `|1|hash|hash` (hashed — skipped)
 *
 * Pure: `knownHostsText` → `readonly KnownHostEntry[]`.
 */
export function parseKnownHosts(knownHostsText: string): readonly KnownHostEntry[] {
	const entries: KnownHostEntry[] = [];
	const seen = new Set<string>();

	for (const raw of knownHostsText.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;

		// First whitespace-delimited field is the host markers (comma-list).
		const firstSpace = findSpace(line);
		const firstField = firstSpace === -1 ? line : line.slice(0, firstSpace);

		for (const marker of firstField.split(",")) {
			const trimmed = marker.trim();
			if (trimmed === "" || trimmed.startsWith("|")) continue; // skip hashed

			let hostname: string;
			let port = 22;

			if (trimmed.startsWith("[")) {
				// [hostname]:port  or  [hostname]
				const bracketEnd = trimmed.indexOf("]");
				if (bracketEnd === -1) continue; // malformed
				hostname = trimmed.slice(1, bracketEnd);
				const afterBracket = trimmed.slice(bracketEnd + 1);
				if (afterBracket.startsWith(":")) {
					const n = Number.parseInt(afterBracket.slice(1), 10);
					if (Number.isFinite(n) && n > 0) port = n;
				}
			} else {
				hostname = trimmed;
			}

			// Dedup by hostname — first port wins (a host with entries on
			// multiple ports gets one computer; use config for a specific port).
			if (seen.has(hostname)) continue;
			seen.add(hostname);
			entries.push({ hostname, port });
		}
	}

	return entries;
}

// ─── reject-list glob matching ─────────────────────────────────────────────

/**
 * Test whether a hostname should be rejected (hidden from the catalog).
 * Patterns support `*` (any chars) and `?` (single char), matching SSH's
 * own wildcard semantics. A bare hostname pattern matches exactly.
 *
 * Pure: `alias` + `patterns` → `boolean`.
 */
export function isRejected(alias: string, patterns?: readonly string[]): boolean {
	if (patterns === undefined || patterns.length === 0) return false;
	return patterns.some((p) => globMatch(p, alias));
}

/**
 * Minimal glob matcher: `*` matches any sequence (including empty), `?`
 * matches a single character. Case-insensitive (hostnames are). All other
 * characters match literally.
 */
function globMatch(pattern: string, input: string): boolean {
	const p = pattern.toLowerCase();
	const s = input.toLowerCase();
	return globMatchImpl(p, 0, s, 0);
}

function globMatchImpl(p: string, pi: number, s: string, si: number): boolean {
	while (pi < p.length) {
		const pc = p[pi];
		if (pc === "*") {
			// Skip consecutive * (they're equivalent to one).
			while (pi + 1 < p.length && p[pi + 1] === "*") pi++;
			// If * is the last char, match everything remaining.
			if (pi + 1 === p.length) return true;
			// Try to match the rest of the pattern at every position in s.
			for (let i = si; i <= s.length; i++) {
				if (globMatchImpl(p, pi + 1, s, i)) return true;
			}
			return false;
		}
		if (pc === "?") {
			if (si >= s.length) return false;
			pi++;
			si++;
			continue;
		}
		// Literal char.
		if (si >= s.length || p[pi] !== s[si]) return false;
		pi++;
		si++;
	}
	return si === s.length;
}
