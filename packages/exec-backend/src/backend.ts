/**
 * ExecBackend — the transport-agnostic spawn + minimal filesystem surface.
 *
 * Tools (tool-shell, tool-read-file, tool-write-file, tool-edit-file) program
 * against THIS abstraction instead of `node:fs` / `node:child_process` directly.
 * Two implementations exist:
 *
 * - `LocalExecBackend` — wraps today's node calls (behavior-identical).
 * - `SshExecBackend` — wraps ssh2 `exec` + `sftp` (added later by the `ssh`
 *   package; not this package's concern — but THIS interface is the seam it
 *   implements).
 *
 * The surface is deliberately SMALL (only what the bundled tools use) so a
 * remote implementation is tractable. New operations are added here, not ad hoc.
 *
 * Resolved per-call from `ToolExecuteContext.computerId` via the injected
 * `ExecBackendResolver` (see `./service.js`). `computerId` undefined → local.
 *
 * Error contract: `readFile`/`stat`/`readdir`/`writeFile` throw node:fs-style
 * errors carrying a `.code` property (e.g. `"ENOENT"`) so the tools' existing
 * error branches work unchanged. `exists` never throws (returns `false` on
 * missing). The SshExecBackend maps ssh2 errors onto these same shapes.
 */

/** A spawned process's result. Mirrors tool-shell's `SpawnResult` exactly. */
export interface ExecResult {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
}

/** Parameters for spawning a shell command. Mirrors tool-shell's `SpawnShell` params. */
export interface SpawnParams {
	readonly command: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly timeout: number;
	readonly onOutput: (data: string, stream: "stdout" | "stderr") => void;
}

/** Stat result — the subset read_file / write_file / edit_file need. */
export interface StatResult {
	readonly isFile: boolean;
	readonly isDirectory: boolean;
}

/** A directory entry — the subset read_file lists. */
export interface DirEntry {
	readonly name: string;
	readonly isDirectory: boolean;
}

/**
 * The execution backend: spawn + a minimal filesystem surface.
 * Tools program against THIS, never against `node:fs`. Resolved per-call from
 * `ToolExecuteContext.computerId` via the injected resolver.
 */
export interface ExecBackend {
	/** Run a shell command, streaming stdout/stderr. The shell-tool seam. */
	readonly spawn: (params: SpawnParams) => Promise<ExecResult>;

	// --- filesystem (the read_file / write_file / edit_file surface) ---

	/** Read a file as utf8 text. Throws node:fs-style errors with `.code`. */
	readonly readFile: (path: string) => Promise<string>;

	/** Write utf8 text to a file. Throws on failure (e.g. missing parent dir). */
	readonly writeFile: (path: string, content: string) => Promise<void>;

	/** Stat a path. Throws node:fs-style errors with `.code` (e.g. `"ENOENT"`). */
	readonly stat: (path: string) => Promise<StatResult>;

	/** List directory entries. Throws node:fs-style errors with `.code`. */
	readonly readdir: (path: string) => Promise<readonly DirEntry[]>;

	/** Check existence without throwing (returns `false` when the path is missing). */
	readonly exists: (path: string) => Promise<boolean>;
}
