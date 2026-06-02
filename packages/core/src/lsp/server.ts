import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { LspServerConfig } from "../types/index.js";
import type { LspServerHandle } from "./client.js";

/**
 * A resolved, ready-to-spawn LSP server derived from a `dispatch.toml`
 * `[lsp.<id>]` entry. Config-driven only — dispatch ships no builtin server
 * registry and performs no auto-download (unlike opencode). The declared
 * executable (`command[0]`) must already be on PATH.
 */
export interface ResolvedLspServer {
	id: string;
	/** Extensions (with leading dot) this server attaches to, e.g. `".luau"`. */
	extensions: string[];
	/** Launch the server over stdio rooted at `root`. */
	spawn(root: string): LspServerHandle;
}

/**
 * Spawn a child process for an LSP server over stdio. Inherits `process.env`
 * (so a PATH-resident `rojo` is visible to luau-lsp's sourcemap autogenerate)
 * and merges any `env` from the server config on top.
 */
function spawnServer(
	command: string[],
	cwd: string,
	env: Record<string, string> | undefined,
	initialization: Record<string, unknown> | undefined,
): LspServerHandle {
	const [cmd, ...args] = command;
	if (!cmd) throw new Error("LSP server command is empty");
	const proc = spawn(cmd, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
	return {
		process: proc,
		...(initialization ? { initialization } : {}),
	};
}

/**
 * Turn the parsed `dispatch.toml` `lsp` block into a list of spawnable
 * servers. Disabled entries are dropped. Entries with no `command`/`extensions`
 * are skipped defensively (the config validator already enforces these, but we
 * guard here too so a hand-built config object can't crash the manager).
 */
export function resolveServersFromConfig(
	lsp: Record<string, LspServerConfig> | undefined,
): ResolvedLspServer[] {
	if (!lsp) return [];
	const servers: ResolvedLspServer[] = [];
	for (const [id, entry] of Object.entries(lsp)) {
		if (entry.disabled) continue;
		if (!entry.command || entry.command.length === 0) continue;
		if (!entry.extensions || entry.extensions.length === 0) continue;
		const command = entry.command;
		const env = entry.env;
		const initialization = entry.initialization;
		servers.push({
			id,
			extensions: entry.extensions,
			spawn: (root: string) => spawnServer(command, root, env, initialization),
		});
	}
	return servers;
}
