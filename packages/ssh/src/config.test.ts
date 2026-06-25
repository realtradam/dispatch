import { describe, expect, it } from "vitest";
import {
	isRejected,
	knownHostToken,
	parseKnownHosts,
	resolveComputer,
	resolveComputers,
	type SshConfigResolveEnv,
} from "./config.js";

const env = (overrides: Partial<SshConfigResolveEnv> = {}): SshConfigResolveEnv => ({
	configText: "",
	knownHostsText: "",
	defaultUser: "fallback-user",
	homeDir: "/home/test",
	...overrides,
});

const FIXTURE = `
# top-level comment
Host *
  ServerAliveInterval 60

Host myserver
  HostName 10.0.0.5
  Port 2222
  User deploy
  IdentityFile ~/.ssh/deploy_key

Host web *.example.com
  HostName web.internal
  User webuser

Host barehost
  # no HostName → falls back to alias

Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_key
`;

describe("resolveComputers", () => {
	it("returns one Computer per named (non-wildcard) Host alias, sorted", () => {
		const computers = resolveComputers(env({ configText: FIXTURE }));
		expect(computers.map((c) => c.alias)).toEqual(["barehost", "github.com", "myserver", "web"]);
	});

	it("skips wildcard-only Host patterns (* and ?)", () => {
		const computers = resolveComputers(env({ configText: FIXTURE }));
		// The bare `*` host is a pattern, not a computer — excluded.
		expect(computers.find((c) => c.alias === "*")).toBeUndefined();
	});

	it("skips wildcard aliases within a multi-alias Host line (*.example.com)", () => {
		const computers = resolveComputers(env({ configText: FIXTURE }));
		expect(computers.find((c) => c.alias === "*.example.com")).toBeUndefined();
		// but the named alias on the SAME line (web) is included.
		expect(computers.find((c) => c.alias === "web")).toBeDefined();
	});

	it("resolves HostName/Port/User/IdentityFile from the config (first-match-wins)", () => {
		const computers = resolveComputers(env({ configText: FIXTURE }));
		const my = computers.find((c) => c.alias === "myserver");
		expect(my).toEqual({
			alias: "myserver",
			hostName: "10.0.0.5",
			port: 2222,
			user: "deploy",
			identityFile: "/home/test/.ssh/deploy_key",
			knownHost: false,
		});
	});

	it("falls back HostName → alias when no HostName is set", () => {
		const computers = resolveComputers(env({ configText: FIXTURE }));
		const bare = computers.find((c) => c.alias === "barehost");
		expect(bare?.hostName).toBe("barehost");
		expect(bare?.port).toBe(22);
		expect(bare?.user).toBe("fallback-user");
		expect(bare?.identityFile).toBeNull();
	});

	it("expands ~ in IdentityFile to homeDir", () => {
		const computers = resolveComputers(env({ configText: FIXTURE }));
		const gh = computers.find((c) => c.alias === "github.com");
		expect(gh?.identityFile).toBe("/home/test/.ssh/github_key");
	});

	it("resolves a Host block whose first alias is a wildcard but later alias is named", () => {
		const computers = resolveComputers(env({ configText: FIXTURE }));
		const web = computers.find((c) => c.alias === "web");
		expect(web?.hostName).toBe("web.internal");
		expect(web?.user).toBe("webuser");
	});

	it("de-dups aliases listed in multiple Host lines (first wins)", () => {
		const dup = `
Host dup
  HostName first.example
Host dup
  HostName second.example
`;
		const computers = resolveComputers(env({ configText: dup }));
		expect(computers).toHaveLength(1);
		expect(computers[0]?.hostName).toBe("first.example");
	});

	it("knownHost=true when the resolved HostName:port token is in known_hosts", () => {
		// myserver is port 2222 → token is [10.0.0.5]:2222; web is port 22 → bare host.
		const known = "[10.0.0.5]:2222 ssh-ed25519 AAA\nweb.internal ssh-ed25519 BBB\n";
		const computers = resolveComputers(env({ configText: FIXTURE, knownHostsText: known }));
		expect(computers.find((c) => c.alias === "myserver")?.knownHost).toBe(true);
		// default port 22 → token is just the hostName (no bracket).
		expect(computers.find((c) => c.alias === "web")?.knownHost).toBe(true);
		expect(computers.find((c) => c.alias === "barehost")?.knownHost).toBe(false);
	});

	it("knownHost keys a non-default port as [host]:port", () => {
		const known = "[10.0.0.5]:2222 ssh-ed25519 AAA\n";
		const computers = resolveComputers(env({ configText: FIXTURE, knownHostsText: known }));
		expect(computers.find((c) => c.alias === "myserver")?.knownHost).toBe(true);
	});
});

describe("resolveComputer (single alias)", () => {
	it("resolves a named alias", () => {
		const c = resolveComputer("myserver", env({ configText: FIXTURE }));
		expect(c?.hostName).toBe("10.0.0.5");
		expect(c?.port).toBe(2222);
	});

	it("returns null for an unknown alias", () => {
		expect(resolveComputer("nope", env({ configText: FIXTURE }))).toBeNull();
	});

	it("returns null for a wildcard alias (not a selectable computer)", () => {
		expect(resolveComputer("*.example.com", env({ configText: FIXTURE }))).toBeNull();
	});

	it("applies top-level wildcard defaults to a named host (first-match-wins)", () => {
		const cfg = `
Host *
  ServerAliveInterval 60
  User stardefault
Host named
  HostName named.example
`;
		const c = resolveComputer("named", env({ configText: cfg }));
		// User inherited from the `Host *` block via first-match-wins.
		expect(c?.user).toBe("stardefault");
		expect(c?.hostName).toBe("named.example");
	});
});

describe("knownHostToken", () => {
	it("returns the bare host for the default port (22)", () => {
		expect(knownHostToken("host.example", 22)).toBe("host.example");
	});

	it("returns [host]:port for a non-default port", () => {
		expect(knownHostToken("host.example", 2222)).toBe("[host.example]:2222");
	});
});

// ─── known_hosts discovery ─────────────────────────────────────────────────

const KNOWN_HOSTS_FIXTURE = [
	"# comment line",
	"arch-razer ssh-ed25519 AAAA1",
	"xenifse1 ssh-ed25519 AAAA2",
	"xenifse1 ssh-rsa AAAA3",
	"xenifse1 ecdsa-sha2-nistp256 AAAA4",
	"[xenifse1]:2222 ssh-ed25519 AAAA5",
	"github.com ssh-ed25519 AAAA6",
	"|1|+W4/jC7U8rJwiEC2m0KvG2A7uAA=|rWwV8p5J1FfR3k= ssh-ed25519 AAAA7",
	"localhost ssh-ed25519 AAAA8",
	"[localhost]:2222 ssh-ed25519 AAAA9",
].join("\n");

describe("parseKnownHosts", () => {
	it("extracts hostnames with default port 22 from bare entries", () => {
		const entries = parseKnownHosts(KNOWN_HOSTS_FIXTURE);
		const arch = entries.find((e) => e.hostname === "arch-razer");
		expect(arch).toEqual({ hostname: "arch-razer", port: 22 });
	});

	it("extracts hostname + port from [host]:port notation", () => {
		const entries = parseKnownHosts(KNOWN_HOSTS_FIXTURE);
		// xenifse1 has entries on port 22 (first) and port 2222 — first wins.
		const xen = entries.find((e) => e.hostname === "xenifse1");
		expect(xen?.port).toBe(22);
		// localhost appears as port 22 (first) and [localhost]:2222 — first wins.
		const local = entries.find((e) => e.hostname === "localhost");
		expect(local?.port).toBe(22);
	});

	it("deduplicates by hostname (first port wins)", () => {
		const entries = parseKnownHosts(KNOWN_HOSTS_FIXTURE);
		const xenCount = entries.filter((e) => e.hostname === "xenifse1").length;
		expect(xenCount).toBe(1);
		// Multiple key types (ed25519, rsa, ecdsa) for the same host:port = 1 entry.
		expect(entries).toHaveLength(4); // arch-razer, xenifse1, github.com, localhost
	});

	it("skips hashed entries (|1|...)", () => {
		const entries = parseKnownHosts(KNOWN_HOSTS_FIXTURE);
		expect(entries.find((e) => e.hostname.startsWith("|"))).toBeUndefined();
	});

	it("skips comment lines and empty lines", () => {
		const entries = parseKnownHosts("\n# comment\n\n  \nhost1 ssh-ed25519 AAA\n");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.hostname).toBe("host1");
	});

	it("returns empty for empty text", () => {
		expect(parseKnownHosts("")).toEqual([]);
		expect(parseKnownHosts("   \n\n  ")).toEqual([]);
	});

	it("handles comma-separated host markers", () => {
		const entries = parseKnownHosts("hostA,hostB ssh-ed25519 AAA\n");
		expect(entries.map((e) => e.hostname)).toEqual(["hostA", "hostB"]);
	});

	it("preserves non-default port when the host only has [host]:port entries", () => {
		const entries = parseKnownHosts("[specialhost]:9999 ssh-ed25519 AAA\n");
		expect(entries[0]).toEqual({ hostname: "specialhost", port: 9999 });
	});
});

// ─── known_hosts discovery merged into resolveComputers ───────────────────

describe("resolveComputers with known_hosts discovery", () => {
	it("discovers computers from known_hosts when no ~/.ssh/config exists", () => {
		const computers = resolveComputers(env({ knownHostsText: KNOWN_HOSTS_FIXTURE }));
		const aliases = computers.map((c) => c.alias);
		expect(aliases).toContain("arch-razer");
		expect(aliases).toContain("xenifse1");
		expect(aliases).toContain("github.com");
		expect(aliases).toContain("localhost");
	});

	it("defaulted params for known_hosts-discovered computers", () => {
		const computers = resolveComputers(env({ knownHostsText: KNOWN_HOSTS_FIXTURE }));
		const arch = computers.find((c) => c.alias === "arch-razer");
		expect(arch).toEqual({
			alias: "arch-razer",
			hostName: "arch-razer",
			port: 22,
			user: "fallback-user",
			identityFile: null,
			knownHost: true,
		});
	});

	it("config entries take precedence over known_hosts (no duplication)", () => {
		const cfg = `
Host arch-razer
  HostName 192.168.1.100
  User root
  Port 2222
`;
		const computers = resolveComputers(
			env({ configText: cfg, knownHostsText: KNOWN_HOSTS_FIXTURE }),
		);
		const arch = computers.filter((c) => c.alias === "arch-razer");
		expect(arch).toHaveLength(1);
		// Config params win, not the known_hosts defaults.
		expect(arch[0]?.hostName).toBe("192.168.1.100");
		expect(arch[0]?.user).toBe("root");
		expect(arch[0]?.port).toBe(2222);
	});

	it("merges config + known_hosts entries (union, sorted)", () => {
		const cfg = `
Host server-a
  HostName 10.0.0.1
`;
		const computers = resolveComputers(
			env({ configText: cfg, knownHostsText: KNOWN_HOSTS_FIXTURE }),
		);
		const aliases = computers.map((c) => c.alias);
		// config entry + known_hosts entries, all unique, sorted.
		expect(aliases).toEqual(["arch-razer", "github.com", "localhost", "server-a", "xenifse1"]);
	});
});

// ─── reject-list filtering ────────────────────────────────────────────────

describe("resolveComputers with rejectPatterns", () => {
	it("filters out exact-match rejected hostnames", () => {
		const computers = resolveComputers(
			env({
				knownHostsText: KNOWN_HOSTS_FIXTURE,
				rejectPatterns: ["github.com"],
			}),
		);
		expect(computers.find((c) => c.alias === "github.com")).toBeUndefined();
		expect(computers.find((c) => c.alias === "arch-razer")).toBeDefined();
	});

	it("filters out glob patterns (* matches any sequence)", () => {
		const computers = resolveComputers(
			env({
				knownHostsText: KNOWN_HOSTS_FIXTURE,
				rejectPatterns: ["*.com"],
			}),
		);
		expect(computers.find((c) => c.alias === "github.com")).toBeUndefined();
		expect(computers.find((c) => c.alias === "arch-razer")).toBeDefined();
	});

	it("filters multiple patterns", () => {
		const computers = resolveComputers(
			env({
				knownHostsText: KNOWN_HOSTS_FIXTURE,
				rejectPatterns: ["github.com", "localhost"],
			}),
		);
		const aliases = computers.map((c) => c.alias);
		expect(aliases).toEqual(["arch-razer", "xenifse1"]);
	});

	it("does NOT filter resolveComputer (single alias lookup ignores reject list)", () => {
		// resolveComputer is for specific lookups (status, test, connect) —
		// the reject list is a discovery/catalog filter, not access control.
		const c = resolveComputer(
			"github.com",
			env({ knownHostsText: KNOWN_HOSTS_FIXTURE, rejectPatterns: ["github.com"] }),
		);
		expect(c).not.toBeNull();
		expect(c?.alias).toBe("github.com");
	});

	it("empty rejectPatterns does not filter anything", () => {
		const computers = resolveComputers(
			env({ knownHostsText: KNOWN_HOSTS_FIXTURE, rejectPatterns: [] }),
		);
		expect(computers).toHaveLength(4);
	});

	it("absent rejectPatterns does not filter anything", () => {
		const computers = resolveComputers(env({ knownHostsText: KNOWN_HOSTS_FIXTURE }));
		expect(computers).toHaveLength(4);
	});
});

// ─── resolveComputer known_hosts fallback ─────────────────────────────────

describe("resolveComputer with known_hosts fallback", () => {
	it("resolves a host from known_hosts when not in config", () => {
		const c = resolveComputer("arch-razer", env({ knownHostsText: KNOWN_HOSTS_FIXTURE }));
		expect(c).toEqual({
			alias: "arch-razer",
			hostName: "arch-razer",
			port: 22,
			user: "fallback-user",
			identityFile: null,
			knownHost: true,
		});
	});

	it("returns null for a host in neither config nor known_hosts", () => {
		const c = resolveComputer("nonexistent", env({ knownHostsText: KNOWN_HOSTS_FIXTURE }));
		expect(c).toBeNull();
	});

	it("config takes precedence over known_hosts for resolveComputer", () => {
		const cfg = `
Host arch-razer
  HostName 192.168.1.100
  User root
`;
		const c = resolveComputer(
			"arch-razer",
			env({ configText: cfg, knownHostsText: KNOWN_HOSTS_FIXTURE }),
		);
		expect(c?.hostName).toBe("192.168.1.100");
		expect(c?.user).toBe("root");
	});
});

// ─── isRejected glob matching ──────────────────────────────────────────────

describe("isRejected", () => {
	it("matches exact hostname", () => {
		expect(isRejected("github.com", ["github.com"])).toBe(true);
		expect(isRejected("arch-razer", ["github.com"])).toBe(false);
	});

	it("matches * glob (any sequence)", () => {
		expect(isRejected("foo.ts.net", ["*.ts.net"])).toBe(true);
		// * matches zero chars, but the remaining ".ts.net" (with literal dot)
		// still doesn't match "ts.net" — the dot is required.
		expect(isRejected("ts.net", ["*.ts.net"])).toBe(false);
		expect(isRejected("foo.other.net", ["*.ts.net"])).toBe(false);
	});

	it("matches ? glob (single char)", () => {
		expect(isRejected("host1", ["host?"])).toBe(true);
		expect(isRejected("host12", ["host?"])).toBe(false); // ? = exactly one char
	});

	it("is case-insensitive", () => {
		expect(isRejected("GitHub.Com", ["github.com"])).toBe(true);
		expect(isRejected("FOO.TS.NET", ["*.ts.net"])).toBe(true);
	});

	it("returns false for absent or empty patterns", () => {
		expect(isRejected("anything")).toBe(false);
		expect(isRejected("anything", [])).toBe(false);
		expect(isRejected("anything", undefined)).toBe(false);
	});
});
