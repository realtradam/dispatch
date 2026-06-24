/**
 * Shared types for the LSP extension.
 */

export type LspServerState = "connected" | "starting" | "error" | "not-started";

export interface LspServerStatus {
	readonly id: string;
	readonly name: string;
	readonly root: string;
	readonly extensions: readonly string[];
	readonly state: LspServerState;
	readonly error?: string | undefined;
	/**
	 * Which config source this server was resolved from: `".dispatch/lsp.json"`,
	 * `"opencode.json"`, or `"built-in"` (the built-in TypeScript default).
	 * Mirrors the wire `LspServerInfo.configSource` so a broken config file
	 * names itself in the status response.
	 */
	readonly configSource?: string | undefined;
}

export interface LspService {
	/**
	 * Resolve the language servers configured for `cwd`, ensure each is spawned +
	 * initialized (lazy connect), and report live state. Never throws for a single
	 * server's failure — reflect it as state:"error" with a short `error`.
	 */
	status(cwd: string): Promise<readonly LspServerStatus[]>;
}
