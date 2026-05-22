import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { PermissionRule, Ruleset } from "../permission/index.js";
import type { DispatchConfig } from "../types/index.js";
import { validateConfig } from "./schema.js";

const DEFAULT_CONFIG: DispatchConfig = { permissions: {} };

const VALID_ACTIONS = new Set(["allow", "deny", "ask"]);

function validateAction(raw: string): "allow" | "deny" | "ask" {
	if (VALID_ACTIONS.has(raw)) return raw as "allow" | "deny" | "ask";
	console.warn(`dispatch: unrecognized action "${raw}", defaulting to "ask"`);
	return "ask";
}

// Load dispatch.toml from the given directory
export function loadConfig(dir: string): DispatchConfig {
	const tomlPath = join(dir, "dispatch.toml");
	let raw: unknown;
	try {
		const content = readFileSync(tomlPath, "utf-8");
		raw = parse(content);
	} catch (err: unknown) {
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
			// File doesn't exist — return empty default
			return DEFAULT_CONFIG;
		}
		console.warn(
			`dispatch: failed to parse dispatch.toml: ${err instanceof Error ? err.message : String(err)}`,
		);
		throw err;
	}

	const { config, errors } = validateConfig(raw);
	for (const e of errors) {
		console.warn(`dispatch: config warning at ${e.path}: ${e.message}`);
	}
	return config;
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
