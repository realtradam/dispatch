import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionRule, Ruleset } from "../permission/index.js";

// Strip inline comments that appear outside of quoted strings.
// Handles both single- and double-quoted values.
function stripInlineComment(line: string): string {
	// Walk character by character; track whether we're inside quotes.
	let inQuote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuote) {
			if (ch === inQuote) inQuote = null;
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
		} else if (ch === "#") {
			return line.slice(0, i).trimEnd();
		}
	}
	return line;
}

const VALID_ACTIONS = new Set(["allow", "deny", "ask"]);

function validateAction(raw: string): "allow" | "deny" | "ask" {
	if (VALID_ACTIONS.has(raw)) return raw as "allow" | "deny" | "ask";
	console.warn(`dispatch: unrecognized action "${raw}", defaulting to "ask"`);
	return "ask";
}

export interface DispatchConfig {
	permissions: Record<string, string | Record<string, string>>;
}

// Load dispatch.yaml from the given directory
export function loadConfig(dir: string): DispatchConfig {
	const yamlPath = join(dir, "dispatch.yaml");
	try {
		const content = readFileSync(yamlPath, "utf-8");
		return parseYaml(content);
	} catch {
		return { permissions: {} };
	}
}

function expandHome(value: string): string {
	const home = homedir();
	return value.replace(/^\$HOME(?=[\/\\]|$)/, home).replace(/^~(?=[\/\\]|$)/, home);
}

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

// Parse simple YAML for the permissions structure
function parseYaml(content: string): DispatchConfig {
	const permissions: Record<string, string | Record<string, string>> = {};
	const lines = content.split("\n");

	let inPermissions = false;
	let currentKey: string | null = null;

	for (const raw of lines) {
		// Skip comments and blank lines
		const trimmed = raw.trimEnd();
		const stripped = trimmed.trimStart();
		if (stripped === "" || stripped.startsWith("#")) continue;

		const indent = trimmed.length - stripped.length;

		if (indent === 0) {
			// Top-level key
			inPermissions = stripped.startsWith("permissions:");
			currentKey = null;
			continue;
		}

		if (!inPermissions) continue;

		if (indent === 2) {
			// permission key line: "  key: value" or "  key:"
			const colonIdx = stripped.indexOf(":");
			if (colonIdx === -1) continue;
			const key = stripQuotes(stripped.slice(0, colonIdx).trim());
			const valueRaw = stripInlineComment(stripped.slice(colonIdx + 1).trim()).trim();
			if (valueRaw === "" || valueRaw === null) {
				// nested map follows
				currentKey = key;
				permissions[currentKey] = {};
			} else {
				// inline value
				const value = stripQuotes(valueRaw);
				permissions[key] = value;
				currentKey = null;
			}
			continue;
		}

		if (indent >= 4 && currentKey !== null) {
			// sub-key line: "    "pattern": action"
			const colonIdx = stripped.indexOf(":");
			if (colonIdx === -1) continue;
			const pattern = expandHome(stripQuotes(stripped.slice(0, colonIdx).trim()));
			const actionRaw = stripQuotes(stripInlineComment(stripped.slice(colonIdx + 1).trim()).trim());
			const action = validateAction(actionRaw);
			(permissions[currentKey] as Record<string, string>)[pattern] = action;
		}
	}

	return { permissions };
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
					.replace(/^\$HOME(?=[\/\\]|$)/, home)
					.replace(/^~(?=[\/\\]|$)/, home);
				const action = validateAction(rawAction);
				rules.push({ permission, pattern, action });
			}
		}
	}

	return rules;
}
