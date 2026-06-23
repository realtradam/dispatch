/**
 * Variable resolver — resolves the system-prompt template variables against the
 * current environment (cwd, system state, git, files).
 *
 * The decision logic is pure: all effects (spawning git, reading files) are
 * injected as adapters. The resolver never touches `Bun`/`process` directly
 * except through injectable defaults, so it is fully testable with fakes.
 *
 * Returns a `Map<string, string | null>` keyed by `"type:name"`:
 * - `string` → the variable exists with this value.
 * - `null`   → the variable is "not existing" (file missing, git unavailable, …).
 * Keys that are never set (e.g. an unknown type) are simply absent from the map.
 */

import { hostname as osHostname } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** Result of a spawned command (used for git). */
export interface GitSpawnResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
}

/**
 * Spawn a command and capture its output. Throws are surfaced as `null` by the
 * resolver (e.g. git not installed, bad cwd).
 */
export type GitSpawn = (
	command: readonly string[],
	opts: { readonly cwd: string },
) => Promise<GitSpawnResult>;

/** Filesystem adapter — the read effects the resolver needs. */
export interface ResolverFs {
	readonly readText: (path: string) => Promise<string>;
	readonly exists: (path: string) => Promise<boolean>;
}

/** Injected effects + optional overridable clocks for deterministic tests. */
export interface ResolverAdapters {
	/** Run a command (git) and capture stdout. */
	readonly spawn: GitSpawn;
	/** File read effects. */
	readonly fs: ResolverFs;
	/** Override the current time (defaults to `new Date()`). */
	readonly now?: () => Date;
	/** Override `process.platform` (defaults to the real platform). */
	readonly platform?: () => string;
	/** Override the hostname (defaults to `os.hostname()`). */
	readonly hostname?: () => string;
}

/** Per-construction context forwarded by the session-orchestrator. */
export interface ResolverContext {
	readonly model?: string;
	readonly conversationId?: string;
}

export interface ResolveOptions {
	readonly context?: ResolverContext;
	/** Variable keys referenced by the template (drives dynamic `file:` reads). */
	readonly referencedKeys?: readonly string[];
}

/** Run a git subcommand in `cwd`; return raw stdout on success, else null. */
async function runGit(
	args: readonly string[],
	cwd: string,
	spawn: GitSpawn,
): Promise<string | null> {
	try {
		const res = await spawn(["git", ...args], { cwd });
		if (res.exitCode !== 0) return null;
		return res.stdout;
	} catch {
		return null;
	}
}

/** Read a file (relative to cwd, or absolute). Missing/error → null. */
async function readFile(filePath: string, cwd: string, fs: ResolverFs): Promise<string | null> {
	const abs = isAbsolute(filePath) ? filePath : resolvePath(cwd, filePath);
	try {
		if (!(await fs.exists(abs))) return null;
		return await fs.readText(abs);
	} catch {
		return null;
	}
}

/**
 * Resolve all variables for a construction.
 *
 * Always resolves the fixed catalog (`system:*`, `prompt:*`, `git:*`), plus any
 * `file:<path>` keys present in `options.referencedKeys` (the paths referenced by
 * the template). Unknown types are intentionally left out of the map.
 */
export async function resolveVariables(
	cwd: string,
	adapters: ResolverAdapters,
	options?: ResolveOptions,
): Promise<Map<string, string | null>> {
	const ctx = options?.context;
	const referencedKeys = options?.referencedKeys;
	const now = adapters.now?.() ?? new Date();
	const vars = new Map<string, string | null>();

	// ── system:* ────────────────────────────────────────────────────────────
	vars.set("system:time", now.toISOString());
	vars.set("system:date", now.toISOString().slice(0, 10));
	vars.set("system:os", adapters.platform?.() ?? process.platform);
	vars.set("system:hostname", adapters.hostname?.() ?? osHostname());

	// ── prompt:* ────────────────────────────────────────────────────────────
	vars.set("prompt:cwd", cwd);
	vars.set("prompt:model", ctx?.model ?? null);
	vars.set("prompt:conversation_id", ctx?.conversationId ?? null);

	// ── git:* ────────────────────────────────────────────────────────────────
	// branch is a single value — trim fully; status keeps its leading status
	// indicators, dropping only the trailing newline (trimEnd).
	const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, adapters.spawn);
	vars.set("git:branch", branch === null ? null : branch.trim());
	const status = await runGit(["status", "--short"], cwd, adapters.spawn);
	vars.set("git:status", status === null ? null : status.trimEnd());

	// ── file:<path> (dynamic — only those referenced by the template) ────────
	if (referencedKeys !== undefined) {
		for (const key of referencedKeys) {
			if (key.startsWith("file:")) {
				const filePath = key.slice("file:".length);
				vars.set(key, await readFile(filePath, cwd, adapters.fs));
			}
		}
	}

	return vars;
}
