/**
 * ssh extension — manifest + `activate(host)`.
 *
 * Provides TWO typed service handles (the seams other units already declared):
 *  1. `remoteExecBackendFactoryHandle` (@dispatch/exec-backend) — `(alias) =>
 *     ExecBackend`; this is what makes `resolveBackend(computerId)` return a
 *     remote backend (exec-backend lazy-looks-it-up at tool-execute time).
 *  2. `computerServiceHandle` (@dispatch/transport-http) — the `ComputerService`
 *     the HTTP routes delegate to (list/get/status/test).
 *
 * `activate` builds the service with REAL edges (`node:fs` + real `ssh2.Client`)
 * and registers both. The injected-deps seam (`SshServiceDeps`) lets the
 * integration test drive the same real ssh2 against a live sshd (mirrors how
 * `packages/mcp` injects its spawn/read adapters — no `@dispatch/*` mocking).
 */

import { access, appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { remoteExecBackendFactoryHandle } from "@dispatch/exec-backend";
import type { Extension, HostAPI, Logger, Manifest } from "@dispatch/kernel";
import { computerServiceHandle } from "@dispatch/transport-http/dist/seam.js";
import { Client } from "ssh2";
import {
	resolveComputer as resolveComputerFromConfig,
	type SshConfigResolveEnv,
} from "./config.js";
import { createSshService, type SshServiceDeps } from "./service.js";

export const manifest: Manifest = {
	id: "ssh",
	name: "SSH Remote Execution",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	activation: "eager",
	// exec-backend owns the resolver; ssh provides the remote factory it looks up
	// at runtime (lazy, post-activation). Declaring dependsOn keeps the DAG honest
	// even though the lookup itself is deferred to tool-execute time.
	dependsOn: ["exec-backend"],
	capabilities: { fs: true, network: true },
	contributes: { services: ["ssh", "exec-backend/remote-factory"] },
};

/**
 * Build the ssh extension with injectable edges. The production `extension`
 * passes real `node:fs` + real `ssh2`; a test passes the same real edges
 * against a live sshd (the integration test — no `@dispatch/*` mocking).
 */
export function makeSshExtension(deps: SshServiceDeps): Extension {
	const store: { close: (() => Promise<void>) | null } = { close: null };

	return {
		manifest,
		activate(host: HostAPI) {
			const { service, pool, remoteFactory } = createSshService(deps);
			store.close = () => pool.closeAll();

			host.provideService(remoteExecBackendFactoryHandle, remoteFactory);
			host.provideService(computerServiceHandle, service);

			host.logger.info("ssh extension activated");
		},
		async deactivate() {
			await store.close?.();
			store.close = null;
		},
	};
}

// ─── real node:fs + ssh2 adapters (production wiring) ─────────────────────

/** Path candidates for `dispatch.toml` (global + project-local). */
function dispatchTomlPaths(): readonly string[] {
	const paths = [
		join(homedir(), ".config", "dispatch", "dispatch.toml"), // global
		join(process.cwd(), "dispatch.toml"), // project-local
	];
	return paths;
}

/**
 * Read `[ssh].reject` glob patterns from `dispatch.toml` (global + project).
 * Merges both lists (deduped). Returns `[]` when no file or no `[ssh]` section.
 * Uses `Bun.TOML.parse` (Bun's built-in TOML parser — zero deps).
 */
async function readRejectPatternsImpl(): Promise<readonly string[]> {
	const patterns: string[] = [];
	const seen = new Set<string>();

	for (const path of dispatchTomlPaths()) {
		try {
			const text = await readFile(path, "utf8");
			const parsed = Bun.TOML.parse(text) as {
				ssh?: { reject?: readonly string[] };
			};
			const list = parsed.ssh?.reject;
			if (list !== undefined) {
				for (const p of list) {
					if (typeof p === "string" && !seen.has(p)) {
						seen.add(p);
						patterns.push(p);
					}
				}
			}
		} catch {
			// File missing or parse error → skip silently.
		}
	}

	return patterns;
}

/**
 * Resolve the real `SshServiceDeps` against the live filesystem + ssh2. The
 * `resolveComputer` dep is wired from the pure config reader using the same
 * live `readConfigText`/`readFileText` edges, so the pool connects with params
 * resolved fresh from `~/.ssh/config` on each acquire (decision #4).
 */
export function createSshServiceDeps(hostLogger: Logger): SshServiceDeps {
	const sshDir = join(homedir(), ".ssh");
	const configPath = join(sshDir, "config");
	const knownHostsPath = join(sshDir, "known_hosts");

	const readConfigText = async (): Promise<string> => readFile(configPath, "utf8");
	const readFileText = async (path: string): Promise<string> => readFile(path, "utf8");
	const defaultUser = process.env.USER ?? homedir().split("/").pop() ?? "root";

	/** Read the reject list fresh from `dispatch.toml` on each call. */
	const readRejectPatterns = async (): Promise<readonly string[]> => readRejectPatternsImpl();

	/**
	 * Build the resolve env (config + known_hosts + reject patterns) — shared by
	 * the service methods and the pool's resolveComputer dep.
	 */
	async function readEnv(): Promise<SshConfigResolveEnv> {
		const [configText, knownHostsText, rejectPatterns] = await Promise.all([
			readConfigText().catch(async () => ""),
			readFileText(knownHostsPath).catch(async () => ""),
			readRejectPatterns(),
		]);
		const base: SshConfigResolveEnv = {
			configText,
			knownHostsText,
			defaultUser,
			homeDir: homedir(),
		};
		return rejectPatterns.length > 0 ? { ...base, rejectPatterns } : base;
	}

	return {
		logger: hostLogger,
		homeDir: homedir(),
		defaultUser,
		knownHostsPath,
		readConfigText,
		readFileText,
		readRejectPatterns,
		pathExists: async (path: string) =>
			access(path)
				.then(() => true)
				.catch(() => false),
		appendKnownHosts: async (path: string, line: string) =>
			appendFile(path, `${line}\n`, { encoding: "utf8" }),
		newClient: () => new Client(),
		// Resolve a computer alias → `Computer` by reading the live config +
		// known_hosts. Reads fresh on each call (a Host block or known_hosts
		// entry added between turns is picked up). Does NOT apply the reject
		// list — the pool needs to connect even to hosts hidden from the catalog.
		resolveComputer: async (alias: string) => {
			const env = await readEnv();
			return resolveComputerFromConfig(alias, env);
		},
	};
}

/** Production extension: real `node:fs` + real `ssh2`. */
export const extension: Extension = {
	manifest,
	activate(host: HostAPI) {
		const deps = createSshServiceDeps(host.logger);
		makeSshExtension(deps).activate(host);
	},
};
