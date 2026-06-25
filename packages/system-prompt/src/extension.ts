/**
 * system-prompt extension — manifest + activate(host).
 *
 * Builds the service with real Bun-backed adapters (Bun.file for fs,
 * Bun.spawn for git), persists the template + resolved prompts via a namespaced
 * storage, and provides the service through `systemPromptHandle`.
 *
 * When a conversation has a `computerId` set (remote turn), the service calls
 * `resolveRemoteAdapters` to obtain ExecBackend-backed adapters that read
 * files / run commands on the REMOTE machine (via SSH), so the system prompt
 * reflects the remote OS/hostname/cwd — not the local host's.
 */
import { type ExecBackend, execBackendHandle } from "@dispatch/exec-backend";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import type { GitSpawnResult, ResolverAdapters } from "./resolver.js";
import { createSystemPromptService } from "./service.js";
import { systemPromptHandle } from "./types.js";

export const manifest: Manifest = {
	id: "system-prompt",
	name: "System Prompt",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	activation: "eager",
	// exec-backend provides the resolver used to obtain a remote ExecBackend
	// when computerId is set. The lookup is lazy (at construct time, not
	// activation), but declaring the dep keeps the DAG honest.
	dependsOn: ["exec-backend"],
	capabilities: { fs: true, spawn: true },
	contributes: { services: ["system-prompt"] },
};

/** Run a command and capture stdout/stderr (used for git). */
async function realSpawn(
	command: readonly string[],
	opts: { readonly cwd: string },
): Promise<GitSpawnResult> {
	const proc = Bun.spawn([...command], {
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		Bun.readableStreamToText(proc.stdout),
		Bun.readableStreamToText(proc.stderr),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function realFs() {
	return {
		readText: async (path: string): Promise<string> => Bun.file(path).text(),
		exists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
	};
}

const localAdapters: ResolverAdapters = { spawn: realSpawn, fs: realFs() };

/**
 * Run a single command on a remote ExecBackend and capture stdout. Returns
 * `null` on any error (the resolver treats null as "unavailable").
 */
async function remoteCommand(
	backend: ExecBackend,
	command: string,
	cwd: string,
): Promise<string | null> {
	let stdout = "";
	try {
		const result = await backend.spawn({
			command,
			cwd,
			signal: new AbortController().signal,
			timeout: 10_000,
			onOutput: (data: string, stream: "stdout" | "stderr") => {
				if (stream === "stdout") stdout += data;
			},
		});
		return result.exitCode === 0 ? stdout.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Build `ResolverAdapters` backed by a remote `ExecBackend` (SSH). File reads
 * go through SFTP; git/hostname/uname run over SSH exec. This makes the system
 * prompt reflect the REMOTE machine's OS, hostname, and git state.
 */
function buildRemoteAdapters(backend: ExecBackend, cwd: string): ResolverAdapters {
	return {
		spawn: async (command, opts) => {
			let stdout = "";
			let stderr = "";
			const result = await backend.spawn({
				command: command.join(" "),
				cwd: opts.cwd,
				signal: new AbortController().signal,
				timeout: 10_000,
				onOutput: (data: string, stream: "stdout" | "stderr") => {
					if (stream === "stdout") stdout += data;
					else stderr += data;
				},
			});
			return { stdout, stderr, exitCode: result.exitCode };
		},
		fs: {
			readText: async (path: string): Promise<string> => backend.readFile(path),
			exists: async (path: string): Promise<boolean> => backend.exists(path),
		},
		// Run hostname/uname on the REMOTE machine. These are resolved once per
		// construct call (cached by the service's cwd+computerId cache). If the
		// remote command fails, fall back to a generic value (the resolver will
		// still read /etc/os-release via SFTP for the distro name).
		hostname: async () => (await remoteCommand(backend, "hostname", cwd)) ?? "remote",
		platform: async () => (await remoteCommand(backend, "uname -s", cwd)) ?? "linux",
	};
}

export function activate(host: HostAPI): void {
	const storage = host.storage("system-prompt");

	/**
	 * Resolve remote-backed adapters for a given computerId. Looks up the
	 * ExecBackendResolver (provided by exec-backend, which delegates to ssh's
	 * remote factory when computerId is set) and wraps it in ResolverAdapters.
	 * Falls back to local adapters if the resolver or backend is unavailable.
	 */
	const resolveRemoteAdapters = async (
		computerId: string,
		cwd: string,
	): Promise<ResolverAdapters> => {
		try {
			const resolver = host.getService(execBackendHandle);
			const backend = resolver(computerId);
			return buildRemoteAdapters(backend, cwd);
		} catch {
			// exec-backend not loaded or resolver unavailable → local.
			return localAdapters;
		}
	};

	const service = createSystemPromptService({
		storage,
		adapters: localAdapters,
		resolveRemoteAdapters,
	});
	host.provideService(systemPromptHandle, service);
	host.logger.info("system-prompt: activated");
}

export const extension: Extension = {
	manifest,
	activate,
};
