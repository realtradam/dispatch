import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { PermissionRule, Ruleset } from "../permission/index.js";
import type { DispatchConfig, KeyDefinition, LspServerConfig } from "../types/index.js";
import { validateConfig } from "./schema.js";

const DEFAULT_CONFIG: DispatchConfig = { permissions: {} };

const VALID_ACTIONS = new Set(["allow", "deny", "ask"]);

function validateAction(raw: string): "allow" | "deny" | "ask" {
	if (VALID_ACTIONS.has(raw)) return raw as "allow" | "deny" | "ask";
	console.warn(`dispatch: unrecognized action "${raw}", defaulting to "ask"`);
	return "ask";
}

/**
 * Absolute path to the HOME-directory (global) `dispatch.toml`.
 *
 * Follows the same `~/.config/dispatch/` convention as global agents
 * (`~/.config/dispatch/agents`). This file is OPTIONAL; when present its
 * contents are merged underneath every project/working-directory config so
 * machine-wide settings (e.g. globally available LSP servers) work in any
 * repository without per-repo configuration.
 *
 * The path can be overridden with the `DISPATCH_GLOBAL_CONFIG` environment
 * variable, which is primarily useful for tests (point it at a temp file) but
 * also lets a user relocate the global config.
 */
export function getGlobalConfigPath(): string {
	return (
		process.env.DISPATCH_GLOBAL_CONFIG ?? join(homedir(), ".config", "dispatch", "dispatch.toml")
	);
}

// Parse + validate a single dispatch.toml. Returns null when the file does not
// exist. Re-throws TOML parse errors so a corrupt LOCAL config surfaces loudly
// (callers that must stay resilient, e.g. the global loader, catch it).
function readConfigFile(tomlPath: string): DispatchConfig | null {
	let raw: unknown;
	try {
		const content = readFileSync(tomlPath, "utf-8");
		raw = parse(content);
	} catch (err: unknown) {
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
			// File doesn't exist — signal "no config here".
			return null;
		}
		console.warn(
			`dispatch: failed to parse ${tomlPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		throw err;
	}

	const { config, errors } = validateConfig(raw);
	for (const e of errors) {
		console.warn(`dispatch: config warning at ${e.path}: ${e.message}`);
	}
	return config;
}

/**
 * Load the HOME-directory global `dispatch.toml` (see {@link getGlobalConfigPath}).
 *
 * Always resilient: a missing file yields the empty default and a malformed
 * file is logged but downgraded to the empty default rather than thrown. A
 * broken global config must never break config loading for every repository on
 * the machine.
 */
export function loadGlobalConfig(): DispatchConfig {
	try {
		return readConfigFile(getGlobalConfigPath()) ?? DEFAULT_CONFIG;
	} catch (err) {
		console.warn(
			`dispatch: ignoring global config due to parse error: ${err instanceof Error ? err.message : String(err)}`,
		);
		return DEFAULT_CONFIG;
	}
}

/**
 * Load the effective config for `dir`: the global config MERGED with the
 * project/working-directory `dispatch.toml`, where the LOCAL config takes
 * precedence on conflicts (see {@link mergeConfigs}). A missing local file
 * yields the global config as-is; a missing global file yields the local
 * config as-is.
 *
 * Note: a malformed LOCAL config still throws (callers may surface it), while a
 * malformed GLOBAL config is downgraded to empty by {@link loadGlobalConfig}.
 */
export function loadConfig(dir: string): DispatchConfig {
	const global = loadGlobalConfig();
	const local = readConfigFile(join(dir, "dispatch.toml"));
	if (local === null) return global;
	return mergeConfigs(global, local);
}

// ─── Merge ───────────────────────────────────────────────────────

/**
 * Merge two permission blocks. Local takes precedence on conflicts.
 *
 * - A key present only in one side is carried over verbatim.
 * - A key whose value is a string on either side: local replaces global.
 * - A key that is a nested `{ pattern -> action }` object on BOTH sides is
 *   merged pattern-by-pattern (local patterns override global patterns of the
 *   same name; non-conflicting patterns from both survive).
 *
 * Global groups are emitted before local-only groups, and global patterns
 * before local patterns within a shared group. This ordering matters because
 * `configToRuleset` flattens in iteration order and `evaluate` uses `findLast`
 * (last match wins) — so local rules naturally win.
 */
function mergePermissions(
	global: DispatchConfig["permissions"],
	local: DispatchConfig["permissions"],
): DispatchConfig["permissions"] {
	const result: DispatchConfig["permissions"] = {};
	for (const [key, value] of Object.entries(global)) {
		result[key] = value;
	}
	for (const [key, value] of Object.entries(local)) {
		const existing = result[key];
		if (existing !== undefined && typeof existing !== "string" && typeof value !== "string") {
			// Both nested objects — merge patterns, local wins on conflicts.
			result[key] = { ...existing, ...value };
		} else {
			// Local string, brand-new key, or a string/object type mismatch:
			// local replaces global wholesale.
			result[key] = value;
		}
	}
	return result;
}

/**
 * Merge two key lists by `id`. Local keys override global keys sharing the same
 * id; non-conflicting ids from both lists survive. Global keys keep their
 * relative order (overridden in place) followed by local-only keys.
 */
function mergeKeys(global: KeyDefinition[], local: KeyDefinition[]): KeyDefinition[] {
	const byId = new Map<string, KeyDefinition>();
	for (const key of global) byId.set(key.id, key);
	for (const key of local) byId.set(key.id, key);
	return Array.from(byId.values());
}

/**
 * Merge two `[lsp]` blocks by server id. Local servers override global servers
 * sharing the same id; non-conflicting ids from both sides remain active. This
 * is what lets a global config provide LSP servers to every repository while a
 * project can still override or add its own.
 */
function mergeLsp(
	global: Record<string, LspServerConfig>,
	local: Record<string, LspServerConfig>,
): Record<string, LspServerConfig> {
	return { ...global, ...local };
}

/**
 * Deep-merge a `global` config with a `local` (project/working-directory)
 * config, with LOCAL taking precedence on every conflict. Pure function — does
 * not touch the filesystem and never mutates its inputs.
 */
export function mergeConfigs(global: DispatchConfig, local: DispatchConfig): DispatchConfig {
	const merged: DispatchConfig = {
		permissions: mergePermissions(global.permissions, local.permissions),
	};

	if (global.keys !== undefined || local.keys !== undefined) {
		merged.keys = mergeKeys(global.keys ?? [], local.keys ?? []);
	}

	if (global.lsp !== undefined || local.lsp !== undefined) {
		merged.lsp = mergeLsp(global.lsp ?? {}, local.lsp ?? {});
	}

	return merged;
}

// Convert the config's permission block to a Ruleset
export function configToRuleset(config: DispatchConfig): Ruleset {
	const home = homedir();
	const rules: PermissionRule[] = [];

	for (const [permission, value] of Object.entries(config.permissions)) {
		if (typeof value === "string") {
			const action = validateAction(value);
			rules.push({ permission, pattern: "*", action });
		} else {
			for (const [rawPattern, rawAction] of Object.entries(value)) {
				const pattern = rawPattern
					.replace(/^\$HOME(?=[/\\]|$)/, home)
					.replace(/^~(?=[/\\]|$)/, home);
				const action = validateAction(rawAction);
				rules.push({ permission, pattern, action });
			}
		}
	}

	return rules;
}
