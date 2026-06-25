import { describe, expect, it } from "vitest";
import {
	knownHostToken,
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
