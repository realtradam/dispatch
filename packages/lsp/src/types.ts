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

export interface DiagnosticsResult {
	/** Formatted diagnostic string (filtered by minSeverity). Empty if none. */
	readonly formatted: string;
	/** True if diagnostics took >10s. */
	readonly slow: boolean;
	/** True if the 60s timeout was hit before all servers responded. */
	readonly timedOut: boolean;
}

export interface GetDiagnosticsOpts {
	readonly filePath: string;
	/** Post-edit buffer content. If omitted, the server reads from disk. */
	readonly text?: string;
	readonly cwd: string;
	readonly timeoutMs?: number;
	/** Only include diagnostics with severity ≤ this (1=Error, 2=Warning). Omit for all. */
	readonly minSeverity?: number;
}

export interface LspService {
	/**
	 * Resolve the language servers configured for `cwd`, ensure each is spawned +
	 * initialized (lazy connect), and report live state. Never throws for a single
	 * server's failure — reflect it as state:"error" with a short `error`.
	 */
	status(cwd: string): Promise<readonly LspServerStatus[]>;

	/**
	 * Query ALL connected language servers matching the file's extension for
	 * diagnostics. Merges results tagged by source server. Sends didOpen/didChange
	 * with the provided text (post-edit buffer) so the server checks the in-memory
	 * version, not stale disk content.
	 */
	getDiagnostics(opts: GetDiagnosticsOpts): Promise<DiagnosticsResult>;
}
