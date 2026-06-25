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
import { resolveComputer as resolveComputerFromConfig } from "./config.js";
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

	return {
		logger: hostLogger,
		homeDir: homedir(),
		defaultUser,
		knownHostsPath,
		readConfigText,
		readFileText,
		pathExists: async (path: string) =>
			access(path)
				.then(() => true)
				.catch(() => false),
		appendKnownHosts: async (path: string, line: string) =>
			appendFile(path, `${line}\n`, { encoding: "utf8" }),
		newClient: () => new Client(),
		// Resolve a computer alias → `Computer` by reading the live config. Reads
		// fresh on each call (the config is the source of truth; a Host block added
		// between turns is picked up). Returns null for an unknown/stale alias.
		resolveComputer: async (alias: string) => {
			const [configText, knownHostsText] = await Promise.all([
				readConfigText().catch(async () => ""),
				readFileText(knownHostsPath).catch(async () => ""),
			]);
			return resolveComputerFromConfig(alias, {
				configText,
				knownHostsText,
				defaultUser,
				homeDir: homedir(),
			});
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
